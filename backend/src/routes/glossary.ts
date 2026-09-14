/**
 * Глоссарий в приложении: словарь партнёр → ссылки.
 * Повторяет гугл-таблицу, но со своей валидацией — строка не может «выпасть»
 * из-за пустой ячейки, как это происходит в листе.
 *
 * Ссылки по-прежнему создаются руками в OnlyMonster; здесь их только привязывают
 * к партнёру, а of_tracking_link_id проставляется сразу из OM.
 */
import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { listTrackingLinks } from "../om/client";
import {
  getModelGroup,
  getOMAccountForCreator,
  isRetiredCreator,
  listModels,
  creatorsInModelGroup,
} from "../config/creators";

interface LinkRow {
  id: number;
  partner_id: number;
  campaign_code: string;
  creator: string;
  of_url: string;
  cpf_free: number | null;
  cpf_paid: number | null;
  revshare_pct: number | null;
  source: string | null;
  of_tracking_link_id: number | null;
  created_at: string;
}

interface PartnerRow {
  id: number;
  glossary_name: string;
  display_name: string;
  telegram: string | null;
  type: string | null;
  source: string | null;
  cpf_free: number | null;
  cpf_paid: number | null;
  archived: number;
  active: number;
  om_report_url: string | null;
}

interface NewLinkInput {
  campaign_code?: string;
  creator?: string;
  cpf?: number | string | null;
  source?: string | null;
  of_url?: string | null;
  of_tracking_link_id?: number | null;
}

/** Натуральная сортировка: camp_11 должен идти после camp_2, а не после camp_101. */
function naturalCmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Ссылка платная по коду: это же правило используют отчёты. */
function isPaidCode(code: string): boolean {
  return code.startsWith("camp_paid");
}

function parseCpf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Нормализуем хэндл для поиска дублей партнёра: @Dima и dima — один человек. */
function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const h = raw.trim().toLowerCase().replace(/^@/, "");
  return h || null;
}

export async function registerGlossaryRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  /**
   * GET /api/glossary — партнёры со своими ссылками.
   * ?verify=1 — дополнительно сверить каждую ссылку с OnlyMonster (медленнее:
   * ходит в OM по одному разу на каждую живую модель).
   */
  app.get<{ Querystring: { verify?: string; all?: string } }>("/api/glossary", async (req) => {
    const partners = db
      .prepare(
        `SELECT id, glossary_name, display_name, telegram, type, source, cpf_free, cpf_paid,
                COALESCE(archived, 0) AS archived, COALESCE(active, 1) AS active, om_report_url
         FROM partners ORDER BY display_name COLLATE NOCASE`,
      )
      .all() as PartnerRow[];

    const allLinks = db
      .prepare(
        `SELECT id, partner_id, campaign_code, creator, of_url, cpf_free, cpf_paid,
                revshare_pct, source, of_tracking_link_id, created_at
         FROM links`,
      )
      .all() as LinkRow[];

    /* Скрытые модели (Nekoletta) из глоссария убираем: данные остаются в базе,
       но в интерфейсе их нет. ?all=1 — служебный обход для разбора старых данных. */
    const visibleGroups = new Set(listModels().map((m) => m.group));
    const links =
      req.query.all === "1"
        ? allLinks
        : allLinks.filter((l) => {
            const group = getModelGroup(l.creator);
            return group !== null && visibleGroups.has(group);
          });
    const hiddenLinks = allLinks.length - links.length;

    /* Сверка с OM опциональна: без неё страница открывается мгновенно. */
    let omByCreator: Map<string, Set<string>> | null = null;
    const omErrors: string[] = [];
    if (req.query.verify === "1") {
      omByCreator = new Map();
      const creators = [...new Set(links.map((l) => l.creator))].filter((c) => !isRetiredCreator(c));
      for (const creator of creators) {
        const acct = getOMAccountForCreator(creator);
        if (!acct) {
          omErrors.push(`${creator}: нет OM-аккаунта в конфиге`);
          continue;
        }
        try {
          const omLinks = await listTrackingLinks(acct);
          omByCreator.set(creator, new Set(omLinks.map((l) => l.name)));
        } catch (e) {
          omErrors.push(`${creator}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const byPartner = new Map<number, LinkRow[]>();
    for (const l of links) {
      const list = byPartner.get(l.partner_id);
      if (list) list.push(l);
      else byPartner.set(l.partner_id, [l]);
    }
    /* Внутри партнёра: сначала free, потом paid, и в каждой группе по номеру кампании. */
    for (const list of byPartner.values()) {
      list.sort((a, b) => {
        const paidA = isPaidCode(a.campaign_code) ? 1 : 0;
        const paidB = isPaidCode(b.campaign_code) ? 1 : 0;
        if (paidA !== paidB) return paidA - paidB;
        return naturalCmp(a.campaign_code, b.campaign_code);
      });
    }

    const data = partners.map((p) => {
      const own = byPartner.get(p.id) ?? [];
      return {
        id: p.id,
        display_name: p.display_name,
        glossary_name: p.glossary_name,
        telegram: p.telegram,
        /* Тип партнёра из глоссария: In-house / External. */
        type: p.type,
        source: p.source,
        cpf_free: p.cpf_free,
        cpf_paid: p.cpf_paid,
        archived: !!p.archived,
        /* Тег партнёра: active — работает, lost — отвалился. Правится из глоссария. */
        status: p.active ? "active" : "lost",
        /* Ссылка на shared-отчёт партнёра в кабинете OnlyMonster. */
        om_report_url: p.om_report_url,
        links: own.map((l) => {
          const paid = isPaidCode(l.campaign_code);
          const cpf = paid ? (l.cpf_paid ?? l.cpf_free) : l.cpf_free;
          const known = omByCreator?.get(l.creator);
          return {
            id: l.id,
            campaign_code: l.campaign_code,
            creator: l.creator,
            model: getModelGroup(l.creator),
            tier: paid ? "paid" : "free",
            of_url: l.of_url,
            cpf,
            /* Куда писать правку CPF: у платных исторически заполнен cpf_free,
               но если заведён cpf_paid — правим именно его, иначе правка потеряется. */
            cpf_field: paid && l.cpf_paid !== null ? "cpf_paid" : "cpf_free",
            source: l.source,
            of_tracking_link_id: l.of_tracking_link_id,
            tracked: l.of_tracking_link_id !== null,
            in_om: known ? known.has(l.campaign_code) : null,
            retired: isRetiredCreator(l.creator),
            created_at: l.created_at,
          };
        }),
      };
    });

    /* Ссылки без партнёра в таблице partners — мусор от старых импортов. */
    const orphans = links
      .filter((l) => !partners.some((p) => p.id === l.partner_id))
      .map((l) => ({ id: l.id, campaign_code: l.campaign_code, creator: l.creator, partner_id: l.partner_id }));

    return {
      data,
      meta: {
        partners: data.length,
        links: links.length,
        hidden_links: hiddenLinks,
        untracked: links.filter((l) => l.of_tracking_link_id === null).length,
        no_cpf: links.filter((l) => !l.cpf_free && !l.cpf_paid).length,
        orphans,
        models: listModels().map((m) => ({
          group: m.group,
          label: m.label,
          creators: creatorsInModelGroup(m.group),
        })),
        om_errors: omErrors,
      },
    };
  });

  /**
   * POST /api/glossary/partners — новый партнёр.
   * Ловит дубль по telegram-хэндлу, чтобы не плодить две карточки на одного человека.
   */
  app.post<{
    Body: {
      display_name?: string;
      telegram?: string | null;
      type?: string | null;
      source?: string | null;
      cpf_free?: number | null;
      cpf_paid?: number | null;
      force?: boolean;
    };
  }>("/api/glossary/partners", async (req, reply) => {
    const displayName = (req.body?.display_name ?? "").toString().trim();
    if (!displayName) {
      reply.code(400);
      return { error: "Укажи имя партнёра" };
    }
    const telegram = (req.body?.telegram ?? "").toString().trim() || null;
    const handle = normalizeHandle(telegram);

    if (handle && !req.body?.force) {
      const existing = db
        .prepare(
          `SELECT id, display_name, telegram FROM partners
           WHERE lower(replace(COALESCE(telegram, ''), '@', '')) = ?`,
        )
        .get(handle) as { id: number; display_name: string; telegram: string } | undefined;
      if (existing) {
        reply.code(409);
        return {
          error: `Хэндл ${telegram} уже у партнёра «${existing.display_name}» (id ${existing.id}). Добавь ссылки к нему или сохрани с force=true.`,
          existing,
        };
      }
    }

    /* glossary_name — ключ, по которому партнёра находит импорт листа: держим тот же формат. */
    const glossaryName = telegram ? `${displayName} | ${telegram}` : displayName;
    if (db.prepare("SELECT id FROM partners WHERE glossary_name = ?").get(glossaryName)) {
      reply.code(409);
      return { error: `Партнёр «${glossaryName}» уже есть` };
    }

    const info = db
      .prepare(
        `INSERT INTO partners (glossary_name, display_name, telegram, type, source, cpf_free, cpf_paid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        glossaryName,
        displayName,
        telegram,
        req.body?.type ?? null,
        req.body?.source ?? null,
        parseCpf(req.body?.cpf_free),
        parseCpf(req.body?.cpf_paid),
      );

    return {
      data: db.prepare("SELECT id, glossary_name, display_name, telegram, source FROM partners WHERE id = ?").get(info.lastInsertRowid),
    };
  });

  /**
   * POST /api/glossary/links — привязать пачку ссылок к партнёру.
   * Body: { partner_id, links: [{ campaign_code, creator, cpf, source, of_url?, of_tracking_link_id? }] }
   *
   * Каждая ссылка проверяется до записи; при любой ошибке не пишется ничего —
   * иначе половина пачки молча уезжает в базу, а половина теряется.
   */
  app.post<{ Body: { partner_id?: number; links?: NewLinkInput[] } }>(
    "/api/glossary/links",
    async (req, reply) => {
      const partnerId = Number(req.body?.partner_id);
      const input = req.body?.links ?? [];

      const partner = db.prepare("SELECT id, display_name, source FROM partners WHERE id = ?").get(partnerId) as
        | { id: number; display_name: string; source: string | null }
        | undefined;
      if (!partner) {
        reply.code(404);
        return { error: "Партнёр не найден" };
      }
      if (input.length === 0) {
        reply.code(400);
        return { error: "Не выбрано ни одной ссылки" };
      }

      const errors: Array<{ campaign_code: string; error: string }> = [];
      const prepared: Array<{
        campaign_code: string;
        creator: string;
        of_url: string;
        cpf: number;
        source: string | null;
        of_tracking_link_id: number | null;
      }> = [];

      /* OM тянем по одному разу на модель, а не на каждую ссылку. */
      const omCache = new Map<string, Map<string, { id: string; url: string }>>();
      const omFor = async (creator: string) => {
        if (omCache.has(creator)) return omCache.get(creator)!;
        const acct = getOMAccountForCreator(creator);
        if (!acct) return null;
        const links = await listTrackingLinks(acct);
        const map = new Map(links.map((l) => [l.name, { id: String(l.id), url: l.url }]));
        omCache.set(creator, map);
        return map;
      };

      const seenInBatch = new Set<string>();
      for (const raw of input) {
        const code = (raw.campaign_code ?? "").toString().trim();
        const creator = (raw.creator ?? "").toString().trim();
        const cpf = parseCpf(raw.cpf);

        if (!code) {
          errors.push({ campaign_code: "(пусто)", error: "Нет кода кампании" });
          continue;
        }
        if (!creator) {
          errors.push({ campaign_code: code, error: "Не выбрана модель" });
          continue;
        }
        if (!getOMAccountForCreator(creator)) {
          errors.push({ campaign_code: code, error: `Модель «${creator}» не настроена` });
          continue;
        }
        if (cpf === null || cpf <= 0) {
          errors.push({ campaign_code: code, error: "CPF обязателен и должен быть больше нуля" });
          continue;
        }
        const key = `${creator}::${code}`;
        if (seenInBatch.has(key)) {
          errors.push({ campaign_code: code, error: "Ссылка выбрана в пачке дважды" });
          continue;
        }
        seenInBatch.add(key);

        const dup = db
          .prepare(
            `SELECT l.id, p.display_name AS partner FROM links l
             LEFT JOIN partners p ON p.id = l.partner_id
             WHERE l.creator = ? AND l.campaign_code = ?`,
          )
          .get(creator, code) as { id: number; partner: string | null } | undefined;
        if (dup) {
          errors.push({
            campaign_code: code,
            error: `Уже заведена у «${dup.partner ?? "неизвестный партнёр"}» (ссылка #${dup.id})`,
          });
          continue;
        }

        let ofUrl = (raw.of_url ?? "").toString().trim();
        let trackingId = raw.of_tracking_link_id ?? null;

        if (!isRetiredCreator(creator)) {
          let om: Map<string, { id: string; url: string }> | null = null;
          try {
            om = await omFor(creator);
          } catch (e) {
            errors.push({ campaign_code: code, error: `OnlyMonster недоступен: ${e instanceof Error ? e.message : String(e)}` });
            continue;
          }
          const hit = om?.get(code);
          if (!hit) {
            errors.push({ campaign_code: code, error: `В OnlyMonster нет ссылки «${code}» на модели ${creator}` });
            continue;
          }
          ofUrl = ofUrl || hit.url;
          trackingId = trackingId ?? Number(hit.id);
        }

        if (!ofUrl) {
          errors.push({ campaign_code: code, error: "Нет ссылки OnlyFans" });
          continue;
        }
        if (db.prepare("SELECT id FROM links WHERE of_url = ?").get(ofUrl)) {
          errors.push({ campaign_code: code, error: `Ссылка ${ofUrl} уже заведена` });
          continue;
        }

        prepared.push({
          campaign_code: code,
          creator,
          of_url: ofUrl,
          cpf,
          source: (raw.source ?? partner.source ?? null) as string | null,
          of_tracking_link_id: trackingId,
        });
      }

      if (errors.length > 0) {
        reply.code(400);
        return { error: "Часть ссылок не прошла проверку, ничего не сохранено", errors };
      }

      const ins = db.prepare(
        `INSERT INTO links (partner_id, creator, campaign_code, of_url, cpf_free, cpf_paid, source, of_tracking_link_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const created: number[] = [];
      db.transaction(() => {
        for (const l of prepared) {
          /* CPF платной кампании исторически лежит в cpf_free платной ссылки —
             отчёты читают его оттуда, поэтому пишем туда же. */
          const info = ins.run(
            partner.id,
            l.creator,
            l.campaign_code,
            l.of_url,
            l.cpf,
            null,
            l.source,
            l.of_tracking_link_id,
          );
          created.push(Number(info.lastInsertRowid));
        }
      })();

      return {
        data: {
          partner_id: partner.id,
          created: created.length,
          links: db
            .prepare(
              `SELECT id, campaign_code, creator, of_url, cpf_free, source, of_tracking_link_id
               FROM links WHERE id IN (${created.map(() => "?").join(",")})`,
            )
            .all(...created),
        },
      };
    },
  );

  /**
   * DELETE /api/glossary/links/:id — отвязать ссылку от партнёра.
   * Разрешаем только пока по ней нет собранных данных: иначе удаление
   * молча стирает историю выплат.
   */
  app.delete<{ Params: { id: string } }>("/api/glossary/links/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const link = db.prepare("SELECT id, campaign_code FROM links WHERE id = ?").get(id) as
      | { id: number; campaign_code: string }
      | undefined;
    if (!link) {
      reply.code(404);
      return { error: "Ссылка не найдена" };
    }
    const used = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM daily_om_stats WHERE link_id = ?) AS om,
           (SELECT COUNT(*) FROM daily_sheet_stats WHERE link_id = ?) AS sheet`,
      )
      .get(id, id) as { om: number; sheet: number };
    if (used.om > 0 || used.sheet > 0) {
      reply.code(409);
      return {
        error: `По ссылке ${link.campaign_code} уже есть статистика (${used.om} дней OM, ${used.sheet} дней таблицы). Удаление стёрло бы историю.`,
      };
    }
    db.prepare("DELETE FROM links WHERE id = ?").run(id);
    return { data: { deleted: id } };
  });
}
