/**
 * Управление партнёрами/линками (Фаза A MVP): создание партнёра + правка CPF.
 * Пишет напрямую в БД (не в Google Sheet) — приложение как источник для НОВЫХ партнёров.
 * НЕ трогает логику «Таблицы» (buildDailyReport): только добавляет/правит строки partners/links,
 * которые она и так читает. Под Basic-auth дашборда (как все /api кроме export/webhooks).
 */
import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { listTrackingLinks } from "../om/client";
import { getOMAccountForCreator } from "../config/creators";

interface NewLink {
  campaign_code: string;
  creator?: string;
  tier?: "free" | "paid";
  cpf_free?: number | null;
  cpf_paid?: number | null;
  source?: string | null;
  of_url?: string | null;
  of_tracking_link_id?: number | null;
  revshare_pct?: number | null;
}

/** creator по tier/коду (у Couture все линки идут на Nekoletta Free/Vip). */
function creatorFor(l: NewLink): string {
  if (l.creator) return l.creator;
  const paid = l.tier === "paid" || l.campaign_code.startsWith("camp_paid");
  return paid ? "Nekoletta Vip" : "Nekoletta Free";
}

export async function registerManageRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  /**
   * POST /api/partners — создать партнёра + его линки.
   * Body: { partner: {display_name, glossary_name?, telegram?, source?, wallet?, network?, monthly_fee?, notes?},
   *         links: NewLink[], mode: "auto"|"manual" }
   * mode=auto → для каждого линка подтягиваем of_tracking_link_id + of_url из OM по campaign_code.
   */
  app.post<{ Body: { partner?: Record<string, unknown>; links?: NewLink[]; mode?: "auto" | "manual" } }>(
    "/api/partners",
    async (req, reply) => {
      const partner = (req.body?.partner ?? {}) as Record<string, unknown>;
      const links = req.body?.links ?? [];
      const mode = req.body?.mode === "auto" ? "auto" : "manual";

      if (!partner.display_name) {
        reply.code(400);
        return { error: "partner.display_name required" };
      }
      const glossaryName = (partner.glossary_name as string) || (partner.display_name as string);
      if (db.prepare("SELECT id FROM partners WHERE glossary_name = ?").get(glossaryName)) {
        reply.code(409);
        return { error: `partner already exists (glossary_name=${glossaryName})` };
      }

      /* AUTO: резолвим tracking-id + url из OM по имени кампании (name === campaign_code). */
      const unmatched: string[] = [];
      if (mode === "auto") {
        const cache = new Map<string, Map<string, { id: string; url: string }>>();
        for (const l of links) {
          const acct = getOMAccountForCreator(creatorFor(l));
          if (!acct) continue;
          if (!cache.has(acct)) {
            const om = await listTrackingLinks(acct);
            cache.set(acct, new Map(om.map((x) => [x.name, { id: x.id, url: x.url }])));
          }
          const hit = cache.get(acct)!.get(l.campaign_code);
          if (hit) {
            l.of_tracking_link_id = l.of_tracking_link_id ?? Number(hit.id);
            l.of_url = l.of_url ?? hit.url;
          } else {
            unmatched.push(l.campaign_code);
          }
        }
      }

      const insP = db.prepare(`
        INSERT INTO partners (glossary_name, display_name, telegram, source, monthly_fee, notes, wallet, network, cpf_free, cpf_paid)
        VALUES (@glossary_name, @display_name, @telegram, @source, @monthly_fee, @notes, @wallet, @network, @cpf_free, @cpf_paid)
      `);
      const insL = db.prepare(`
        INSERT INTO links (partner_id, creator, campaign_code, of_url, cpf_free, cpf_paid, revshare_pct, source, of_tracking_link_id)
        VALUES (@partner_id, @creator, @campaign_code, @of_url, @cpf_free, @cpf_paid, @revshare_pct, @source, @of_tracking_link_id)
      `);

      let partnerId = 0;
      try {
        const tx = db.transaction(() => {
          partnerId = Number(
            insP.run({
              glossary_name: glossaryName,
              display_name: partner.display_name ?? null,
              telegram: partner.telegram ?? null,
              source: partner.source ?? null,
              monthly_fee: partner.monthly_fee ?? null,
              notes: partner.notes ?? null,
              wallet: partner.wallet ?? null,
              network: partner.network ?? null,
              cpf_free: partner.cpf_free ?? null,
              cpf_paid: partner.cpf_paid ?? null,
            }).lastInsertRowid,
          );
          for (const l of links) {
            insL.run({
              partner_id: partnerId,
              creator: creatorFor(l),
              campaign_code: l.campaign_code,
              of_url: l.of_url ?? l.campaign_code, // of_url UNIQUE — fallback на код
              cpf_free: l.cpf_free ?? null,
              cpf_paid: l.cpf_paid ?? null,
              revshare_pct: l.revshare_pct ?? null,
              source: l.source ?? (partner.source as string) ?? null,
              of_tracking_link_id: l.of_tracking_link_id ?? null,
            });
          }
        });
        tx();
      } catch (e) {
        reply.code(400);
        return { error: e instanceof Error ? e.message : String(e) };
      }

      return {
        data: {
          partner_id: partnerId,
          links_created: links.length,
          mode,
          unmatched_om: mode === "auto" ? unmatched : [],
        },
      };
    },
  );

  /**
   * PATCH /api/links/:id — правка CPF/source/revshare линка.
   * Выплаты (фаны×cpf) пересчитываются на чтении в «Таблице» автоматически.
   */
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/links/:id",
    async (req, reply) => {
      const id = Number(req.params.id);
      const fields: string[] = [];
      const values: (string | number | null)[] = [];
      for (const key of ["cpf_free", "cpf_paid", "source", "revshare_pct"] as const) {
        if (req.body?.[key] !== undefined) {
          fields.push(`${key} = ?`);
          values.push((req.body[key] as string | number | null) ?? null);
        }
      }
      if (fields.length === 0) {
        reply.code(400);
        return { error: "No fields to update" };
      }
      values.push(id);
      const r = db.prepare(`UPDATE links SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      if (r.changes === 0) {
        reply.code(404);
        return { error: "link not found" };
      }
      return {
        data: db
          .prepare("SELECT id, partner_id, campaign_code, cpf_free, cpf_paid, source, revshare_pct FROM links WHERE id = ?")
          .get(id),
      };
    },
  );
}
