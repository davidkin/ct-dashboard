/**
 * Управление партнёрами/линками (Фаза A MVP): создание партнёра + правка CPF.
 * Пишет напрямую в БД (не в Google Sheet) — приложение как источник для НОВЫХ партнёров.
 * НЕ трогает логику «Таблицы» (buildDailyReport): только добавляет/правит строки partners/links,
 * которые она и так читает. Под Basic-auth дашборда (как все /api кроме export/webhooks).
 */
import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { getDb } from "../db/index";
import { requireAdmin } from "../lib/auth";
import { listTrackingLinks } from "../om/client";
import {
  creatorsInModelGroup,
  getCreatorType,
  getOMAccountForCreator,
  isRetiredCreator,
  listModels,
} from "../config/creators";
import { lastCompletedWeekStart, todayLocal } from "../lib/tz";
import { pickCpf } from "../daily/report";

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

/** creator по tier/коду: модель берём первую живую из конфига, а не захардкоженную. */
function creatorFor(l: NewLink): string {
  if (l.creator) return l.creator;
  const paid = l.tier === "paid" || l.campaign_code.startsWith("camp_paid");
  const wanted = paid ? "vip" : "free";
  const model = listModels()[0];
  const creator = model
    ? creatorsInModelGroup(model.group).find((c) => getCreatorType(c) === wanted)
    : undefined;
  return creator ?? (paid ? "Nekoletta Vip" : "Nekoletta Free");
}

export async function registerManageRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  /**
   * GET /api/om/tracking-links — все tracking-линки из OM (оба аккаунта Free+Vip)
   * для селекта при создании партнёра. Помечаем уже привязанные к партнёру.
   */
  app.get("/api/om/tracking-links", async (_req, reply) => {
    /* Аккаунты берём из конфига моделей: захардкоженные ONLYMONSTER_ACCOUNT_FREE/VIP —
       это Nekoletta, к которой доступ отобран, и её ссылки в селекте бесполезны. */
    const accts = listModels()
      .flatMap((m) => creatorsInModelGroup(m.group))
      .filter((creator) => !isRetiredCreator(creator))
      .map((creator) => ({
        id: getOMAccountForCreator(creator),
        tier: (getCreatorType(creator) === "vip" ? "paid" : "free") as "free" | "paid",
        creator,
      }))
      .filter((a): a is { id: string; tier: "free" | "paid"; creator: string } => !!a.id);

    const assigned = new Map<number, string>();
    for (const r of db
      .prepare(
        `SELECT l.of_tracking_link_id AS tid, p.display_name AS name
         FROM links l JOIN partners p ON p.id = l.partner_id
         WHERE l.of_tracking_link_id IS NOT NULL`,
      )
      .all() as Array<{ tid: number; name: string }>) {
      assigned.set(Number(r.tid), r.name);
    }

    const out: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    for (const a of accts) {
      try {
        const links = await listTrackingLinks(a.id);
        for (const l of links) {
          const tier = l.name.startsWith("camp_paid") ? "paid" : a.tier;
          out.push({
            id: Number(l.id),
            code: l.name,
            url: l.url,
            subscribers: l.subscribers,
            clicks: l.clicks,
            is_active: l.is_active,
            tier,
            creator: a.creator,
            assigned_to: assigned.get(Number(l.id)) ?? null,
          });
        }
      } catch (e) {
        errors.push(`${a.tier}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    out.sort((x, y) => String(x.code).localeCompare(String(y.code), undefined, { numeric: true }));
    return { data: out, errors };
  });

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
   * Выплаты (фаны×cpf) пересчитываются на чтении в «Таблице» автоматически —
   * НО только пока у партнёра+тира нет ни одной записи в cpf_history: как
   * только она появляется (через модалку "история CPF" на странице партнёра),
   * resolveCpf в report.ts полностью игнорирует live-значение на линке и берёт
   * ставку из истории. Поэтому если история уже есть — правка здесь молча ни
   * на что не влияла (реальный баг, нашёл 2026-09-18). Чиним тем же способом:
   * если у партнёра+тира этого линка УЖЕ есть история, кладём новую запись
   * "действует с сегодня" со свежерезолвленным значением — тогда правка
   * реально применяется, начиная с сегодня, не трогая прошлое.
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
      const cpfChanged = req.body?.cpf_free !== undefined || req.body?.cpf_paid !== undefined;
      values.push(id);

      const tx = db.transaction(() => {
        const r = db.prepare(`UPDATE links SET ${fields.join(", ")} WHERE id = ?`).run(...values);
        if (r.changes === 0) return null;

        const link = db
          .prepare(`SELECT id, partner_id, campaign_code, cpf_free, cpf_paid FROM links WHERE id = ?`)
          .get(id) as { id: number; partner_id: number; campaign_code: string; cpf_free: number | null; cpf_paid: number | null };

        if (cpfChanged && link.partner_id) {
          const tier: "free" | "paid" = link.campaign_code.startsWith("camp_paid") ? "paid" : "free";
          const historyCount = db
            .prepare(`SELECT COUNT(*) AS n FROM cpf_history WHERE partner_id = ? AND tier = ?`)
            .get(link.partner_id, tier) as { n: number };
          if (historyCount.n > 0) {
            /* НЕ через pickCpf — тот приоритезирует partner.cpf_free над
               link.cpf_free, а тут нужно ровно то значение, которое юзер
               только что явно поставил на ЭТОТ линк (иначе если у партнёра
               уже стоит live cpf_free, оно молча перекроет свежую правку). */
            const submitted = req.body?.cpf_free ?? req.body?.cpf_paid;
            const currentValue = submitted != null ? Number(submitted) : (link.cpf_free ?? link.cpf_paid ?? 0);
            if (currentValue > 0) {
              const today = todayLocal();
              db.prepare(
                `INSERT INTO cpf_history (partner_id, tier, cpf, effective_from, created_by) VALUES (?, ?, ?, ?, ?)`,
              ).run(link.partner_id, tier, currentValue, today, req.user?.email ?? null);
            }
          }
        }
        return link;
      });

      const link = tx();
      if (!link) {
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

  /**
   * PUT /api/payout-status — статус выплаты партнёру за неделю (Готов/Ожидает).
   * Body: { partner_id, status: "done"|"pending", week_start? }.
   * По умолчанию week_start = понедельник прошлой завершённой недели (за неё платят).
   */
  app.put<{ Body: { partner_id?: number; status?: string; week_start?: string } }>(
    "/api/payout-status",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const partnerId = Number(req.body?.partner_id);
      const status = req.body?.status === "done" ? "done" : "pending";
      const weekStart = req.body?.week_start || lastCompletedWeekStart();
      if (!Number.isFinite(partnerId)) {
        reply.code(400);
        return { error: "partner_id required" };
      }
      db.prepare(
        `INSERT INTO payout_status (partner_id, week_start, status, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(partner_id, week_start)
         DO UPDATE SET status = excluded.status, updated_at = datetime('now')`,
      ).run(partnerId, weekStart, status);
      return { data: { partner_id: partnerId, week_start: weekStart, status } };
    },
  );

  /**
   * POST /api/partners/:id/share-token — секретная ссылка на личный кабинет
   * траффера (ровно как shared report в OnlyMonster): без логина, только
   * по токену. Доступно admin и affiliate_manager — генерация ссылки не
   * входит в «удаление/выплаты/настройки», это обычная работа с партнёром.
   * Повторный вызов возвращает уже существующий токен, не плодит новые.
   */
  app.post<{ Params: { id: string } }>("/api/partners/:id/share-token", async (req, reply) => {
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT id, share_token FROM partners WHERE id = ?`).get(id) as
      | { id: number; share_token: string | null }
      | undefined;
    if (!row) {
      reply.code(404);
      return { error: "Партнёр не найден" };
    }
    let token = row.share_token;
    if (!token) {
      token = randomBytes(20).toString("hex");
      db.prepare(`UPDATE partners SET share_token = ? WHERE id = ?`).run(token, id);
    }
    return { data: { partner_id: id, token } };
  });

  /** DELETE — отозвать ссылку кабинета (старая перестаёт открываться). */
  app.delete<{ Params: { id: string } }>("/api/partners/:id/share-token", async (req, reply) => {
    const id = Number(req.params.id);
    db.prepare(`UPDATE partners SET share_token = NULL WHERE id = ?`).run(id);
    return { data: { partner_id: id } };
  });

  /**
   * GET /api/partners/:id/cpf-history — вся история ставок партнёра (оба тира),
   * свежие сверху. Для чипа-иконки "история" рядом с CPF в интерфейсе.
   */
  app.get<{ Params: { id: string } }>("/api/partners/:id/cpf-history", async (req) => {
    const id = Number(req.params.id);
    const rows = db
      .prepare(
        `SELECT id, tier, cpf, effective_from, created_by, created_at
         FROM cpf_history WHERE partner_id = ?
         ORDER BY effective_from DESC, id DESC`,
      )
      .all(id);
    return { data: rows };
  });

  /**
   * POST /api/partners/:id/cpf-history — новая ставка с конкретной даты.
   * Body: { tier: "free"|"paid", cpf: number, effective_from: "YYYY-MM-DD" }.
   *
   * Это НЕ то же самое, что правка partners.cpf_free/cpf_paid: та правка меняла
   * ставку "всегда была такой" (задним числом пересчитывала прошлые дни при
   * каждом чтении отчёта — то, от чего David и просил уйти). Здесь ставка
   * действует СТРОГО с указанной даты; дни до неё продолжают считаться по
   * тому, что было. Если для партнёра+тира это первая запись в истории —
   * сначала кладём "базовую" запись текущим значением с датой создания
   * партнёра (иначе дни до этой правки откатились бы на фолбэк, который сам
   * может незаметно измениться при следующей правке partners.cpf_free).
   * Доступно admin и affiliate_manager — как и остальная правка CPF.
   */
  app.post<{ Params: { id: string }; Body: { tier?: "free" | "paid"; cpf?: number; effective_from?: string } }>(
    "/api/partners/:id/cpf-history",
    async (req, reply) => {
      const id = Number(req.params.id);
      const tier = req.body?.tier;
      const cpf = Number(req.body?.cpf);
      const effectiveFrom = (req.body?.effective_from ?? "").trim();

      if (tier !== "free" && tier !== "paid") {
        reply.code(400);
        return { error: "tier должен быть free или paid" };
      }
      if (!Number.isFinite(cpf) || cpf <= 0) {
        reply.code(400);
        return { error: "CPF должен быть больше нуля" };
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
        reply.code(400);
        return { error: "Дата должна быть в формате ГГГГ-ММ-ДД" };
      }

      const partnerRow = db
        .prepare(`SELECT id, cpf_free, cpf_paid, created_at FROM partners WHERE id = ?`)
        .get(id) as { id: number; cpf_free: number | null; cpf_paid: number | null; created_at: string } | undefined;
      if (!partnerRow) {
        reply.code(404);
        return { error: "Партнёр не найден" };
      }

      const user = req.user;
      const insert = db.prepare(
        `INSERT INTO cpf_history (partner_id, tier, cpf, effective_from, created_by) VALUES (?, ?, ?, ?, ?)`,
      );

      const tx = db.transaction(() => {
        const existing = db
          .prepare(`SELECT COUNT(*) AS n FROM cpf_history WHERE partner_id = ? AND tier = ?`)
          .get(id, tier) as { n: number };
        if (existing.n === 0) {
          /* Фолбэк без истории читает partner.cpf_* ИЛИ link.cpf_* (см. pickCpf в
             report.ts) — если бы бралось только partner.cpf_free, тут был реальный
             баг: у Media Cloud (free) партнёрская ставка была NULL, реальная 1.2
             жила на ссылках, и без этой строки старые дни задним числом уехали
             бы на новую ставку в момент первого же сохранения. */
          const link = db
            .prepare(
              `SELECT cpf_free, cpf_paid FROM links
               WHERE partner_id = ? AND campaign_code ${tier === "paid" ? "LIKE 'camp\\_paid\\_%' ESCAPE '\\'" : "NOT LIKE 'camp\\_paid\\_%' ESCAPE '\\'"}
               LIMIT 1`,
            )
            .get(id) as { cpf_free: number | null; cpf_paid: number | null } | undefined;
          const currentValue = pickCpf(
            tier,
            partnerRow.cpf_free,
            partnerRow.cpf_paid,
            link?.cpf_free ?? null,
            link?.cpf_paid ?? null,
          );
          if (currentValue > 0) {
            const baselineDate = partnerRow.created_at.slice(0, 10);
            insert.run(id, tier, currentValue, baselineDate, "system: baseline");
          }
        }
        insert.run(id, tier, cpf, effectiveFrom, user?.email ?? null);

        /* Кэш на партнёре — то, что действует СЕГОДНЯ, чтобы места, не знающие
           про историю (Глоссарий, экспорт), продолжали показывать разумное значение. */
        const today = todayLocal();
        const currentRows = db
          .prepare(
            `SELECT cpf FROM cpf_history WHERE partner_id = ? AND tier = ? AND effective_from <= ?
             ORDER BY effective_from DESC, id DESC LIMIT 1`,
          )
          .get(id, tier, today) as { cpf: number } | undefined;
        if (currentRows) {
          const col = tier === "paid" ? "cpf_paid" : "cpf_free";
          db.prepare(`UPDATE partners SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`).run(
            currentRows.cpf,
            id,
          );
        }
      });
      tx();

      return {
        data: db
          .prepare(
            `SELECT id, tier, cpf, effective_from, created_by, created_at
             FROM cpf_history WHERE partner_id = ? ORDER BY effective_from DESC, id DESC`,
          )
          .all(id),
      };
    },
  );

  /**
   * DELETE /api/partners/:id/cpf-history/:historyId — убрать ошибочную запись
   * (миссклик). Только эта строка; остальная история пересчитывается сама на
   * чтении, ничего дополнительно двигать не нужно — resolveCpf в report.ts
   * просто перестанет видеть удалённую запись при сканировании.
   */
  app.delete<{ Params: { id: string; historyId: string } }>(
    "/api/partners/:id/cpf-history/:historyId",
    async (req, reply) => {
      const id = Number(req.params.id);
      const historyId = Number(req.params.historyId);

      const row = db
        .prepare(`SELECT id, tier FROM cpf_history WHERE id = ? AND partner_id = ?`)
        .get(historyId, id) as { id: number; tier: "free" | "paid" } | undefined;
      if (!row) {
        reply.code(404);
        return { error: "Запись истории не найдена" };
      }

      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM cpf_history WHERE id = ?`).run(historyId);

        /* Кэш на партнёре — та же синхронизация, что при добавлении: пересчитать
           "сегодняшнюю" ставку без удалённой строки. Если истории по тиру больше
           не осталось вообще — оставляем кэш как есть (фолбэк на pickCpf сам
           отработает на чтении отчёта). */
        const today = todayLocal();
        const currentRow = db
          .prepare(
            `SELECT cpf FROM cpf_history WHERE partner_id = ? AND tier = ? AND effective_from <= ?
             ORDER BY effective_from DESC, id DESC LIMIT 1`,
          )
          .get(id, row.tier, today) as { cpf: number } | undefined;
        if (currentRow) {
          const col = row.tier === "paid" ? "cpf_paid" : "cpf_free";
          db.prepare(`UPDATE partners SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`).run(
            currentRow.cpf,
            id,
          );
        }
      });
      tx();

      return {
        data: db
          .prepare(
            `SELECT id, tier, cpf, effective_from, created_by, created_at
             FROM cpf_history WHERE partner_id = ? ORDER BY effective_from DESC, id DESC`,
          )
          .all(id),
      };
    },
  );
}
