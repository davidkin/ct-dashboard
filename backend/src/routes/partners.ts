import { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { getDb } from "../db/index";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Per-link delta of metrics in period.
 * Считает: state на конец периода − state ДО начала периода.
 * Если до периода snapshot-ов не было — baseline = 0 → весь end-state идёт «как новое».
 */
function periodLinkDelta(db: Database.Database, from: string, to: string) {
  return db
    .prepare(
      `WITH
         start_state AS (
           SELECT s.link_id,
                  MAX(s.clicks_count)      AS clicks,
                  MAX(s.subscribers_count) AS subs,
                  MAX(s.spenders_count)    AS spenders,
                  MAX(s.revenue_total)     AS revenue
           FROM snapshots s
           WHERE s.ts < datetime(?)
           GROUP BY s.link_id
         ),
         end_state AS (
           SELECT s.link_id,
                  MAX(s.clicks_count)      AS clicks,
                  MAX(s.subscribers_count) AS subs,
                  MAX(s.spenders_count)    AS spenders,
                  MAX(s.revenue_total)     AS revenue
           FROM snapshots s
           WHERE s.ts <= datetime(?, '+1 day')
           GROUP BY s.link_id
         )
       SELECT
         l.id AS link_id, l.partner_id, l.creator,
         l.campaign_code, l.of_url, l.of_created_at,
         l.cpf_free, l.cpf_paid, l.revshare_pct,
         MAX(0, COALESCE(e.clicks, 0)   - COALESCE(st.clicks, 0))   AS clicks,
         MAX(0, COALESCE(e.subs, 0)     - COALESCE(st.subs, 0))     AS subs,
         MAX(0, COALESCE(e.spenders, 0) - COALESCE(st.spenders, 0)) AS spenders,
         MAX(0, COALESCE(e.revenue, 0)  - COALESCE(st.revenue, 0))  AS revenue
       FROM links l
       LEFT JOIN start_state st ON st.link_id = l.id
       LEFT JOIN end_state e    ON e.link_id  = l.id
       WHERE COALESCE(e.clicks, 0) > 0 OR COALESCE(e.subs, 0) > 0`,
    )
    .all(from, to) as Array<{
      link_id: number;
      partner_id: number;
      creator: string;
      campaign_code: string;
      of_url: string;
      of_created_at: string | null;
      cpf_free: number | null;
      cpf_paid: number | null;
      revshare_pct: number | null;
      clicks: number;
      subs: number;
      spenders: number;
      revenue: number;
    }>;
}

export async function registerPartnerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/partners?creator=<name>&from=YYYY-MM-DD&to=YYYY-MM-DD
   * Возвращает партнёров с агрегатами.
   * Если указан creator — фильтруем по модели.
   * Если указан период from/to — метрики считаются как DELTA из snapshots
   * (state в конце периода − state до начала). Adult-Angels-style.
   */
  app.get<{ Querystring: { creator?: string; from?: string; to?: string } }>(
    "/api/partners",
    async (req) => {
      const db = getDb();
      const creator = req.query.creator?.trim();
      const periodActive = !!(req.query.from && req.query.to && DATE_RE.test(req.query.from) && DATE_RE.test(req.query.to));
      if (periodActive) {
        return periodMode(db, req.query.from!, req.query.to!, creator);
      }
      return classicMode(db, creator);
    },
  );

  async function classicMode(db: Database.Database, creator?: string) {

    const sql = creator
      ? `SELECT
           p.id, p.display_name, p.glossary_name, p.telegram, p.type, p.source,
           p.monthly_fee, p.notes,
           COUNT(l.id)              AS links_count,
           SUM(l.clicks_count)      AS clicks_total,
           SUM(l.subscribers_count) AS subs_total,
           SUM(l.spenders_count)    AS spenders_total,
           SUM(l.revenue_total)     AS revenue_total,
           SUM(
             CASE
               WHEN l.revshare_pct IS NOT NULL AND COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                 THEN MAX(COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free), COALESCE(l.revenue_total, 0) * l.revshare_pct)
               WHEN l.revshare_pct IS NOT NULL
                 THEN COALESCE(l.revenue_total, 0) * l.revshare_pct
               WHEN COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                 THEN COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free)
               ELSE 0
             END
           ) AS payout_total,
           MAX(l.last_synced_at)    AS last_synced_at
         FROM partners p
         LEFT JOIN links l ON l.partner_id = p.id AND l.creator = ?
         GROUP BY p.id
         HAVING COUNT(l.id) > 0
         ORDER BY p.display_name COLLATE NOCASE`
      : `SELECT
           p.id, p.display_name, p.glossary_name, p.telegram, p.type, p.source,
           p.monthly_fee, p.notes,
           COUNT(l.id)              AS links_count,
           SUM(l.clicks_count)      AS clicks_total,
           SUM(l.subscribers_count) AS subs_total,
           SUM(l.spenders_count)    AS spenders_total,
           SUM(l.revenue_total)     AS revenue_total,
           SUM(
             CASE
               WHEN l.revshare_pct IS NOT NULL AND COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                 THEN MAX(COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free), COALESCE(l.revenue_total, 0) * l.revshare_pct)
               WHEN l.revshare_pct IS NOT NULL
                 THEN COALESCE(l.revenue_total, 0) * l.revshare_pct
               WHEN COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                 THEN COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free)
               ELSE 0
             END
           ) AS payout_total,
           MAX(l.last_synced_at)    AS last_synced_at
         FROM partners p
         LEFT JOIN links l ON l.partner_id = p.id
         GROUP BY p.id
         ORDER BY p.display_name COLLATE NOCASE`;

    const rows = (creator
      ? db.prepare(sql).all(creator)
      : db.prepare(sql).all()) as Array<{
        id: number;
        [k: string]: unknown;
      }>;

    /* === Per-creator breakdown (для раскрывающихся строк) === */
    const breakdownSql = `
      SELECT
        l.partner_id, l.creator,
        COUNT(l.id)              AS links_count,
        SUM(l.clicks_count)      AS clicks_total,
        SUM(l.subscribers_count) AS subs_total,
        SUM(l.spenders_count)    AS spenders_total,
        SUM(l.revenue_total)     AS revenue_total,
        SUM(
          CASE
            WHEN l.revshare_pct IS NOT NULL AND COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
              THEN MAX(COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free), COALESCE(l.revenue_total, 0) * l.revshare_pct)
            WHEN l.revshare_pct IS NOT NULL
              THEN COALESCE(l.revenue_total, 0) * l.revshare_pct
            WHEN COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
              THEN COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free)
            ELSE 0
          END
        ) AS payout_total
      FROM links l
      WHERE l.partner_id IN (${rows.map(() => "?").join(",") || "NULL"})
      ${creator ? "AND l.creator = ?" : ""}
      GROUP BY l.partner_id, l.creator
      ORDER BY l.creator`;
    const breakdownParams = creator
      ? [...rows.map((r) => r.id), creator]
      : rows.map((r) => r.id);
    const breakdown = rows.length > 0
      ? db.prepare(breakdownSql).all(...breakdownParams) as Array<{
          partner_id: number;
          creator: string;
          links_count: number;
          clicks_total: number | null;
          subs_total: number | null;
          spenders_total: number | null;
          revenue_total: number | null;
          payout_total: number | null;
        }>
      : [];

    /* === Per-link details (для 3-го уровня раскрытия партнёр → модель → ссылка) === */
    const linksSql = `
      SELECT
        l.partner_id, l.creator,
        l.id, l.campaign_code, l.of_url, l.of_created_at,
        l.cpf_free, l.cpf_paid, l.revshare_pct,
        COALESCE(l.clicks_count, 0)      AS clicks_count,
        COALESCE(l.subscribers_count, 0) AS subscribers_count,
        COALESCE(l.spenders_count, 0)    AS spenders_count,
        COALESCE(l.revenue_total, 0)     AS revenue_total,
        (CASE
          WHEN l.revshare_pct IS NOT NULL AND COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
            THEN MAX(COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free), COALESCE(l.revenue_total, 0) * l.revshare_pct)
          WHEN l.revshare_pct IS NOT NULL
            THEN COALESCE(l.revenue_total, 0) * l.revshare_pct
          WHEN COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
            THEN COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free)
          ELSE 0
        END) AS payout_total
      FROM links l
      WHERE l.partner_id IN (${rows.map(() => "?").join(",") || "NULL"})
      ${creator ? "AND l.creator = ?" : ""}
      ORDER BY l.partner_id, l.creator, l.campaign_code COLLATE NOCASE`;
    const linksParams = creator
      ? [...rows.map((r) => r.id), creator]
      : rows.map((r) => r.id);
    const linksRows = rows.length > 0
      ? db.prepare(linksSql).all(...linksParams) as Array<{
          partner_id: number;
          creator: string;
          id: number;
          campaign_code: string;
          of_url: string;
          of_created_at: string | null;
          cpf_free: number | null;
          cpf_paid: number | null;
          revshare_pct: number | null;
          clicks_count: number;
          subscribers_count: number;
          spenders_count: number;
          revenue_total: number;
          payout_total: number;
        }>
      : [];

    /* === Sparkline: per-partner daily clicks last 7 days === */
    const sparkSql = `
      WITH per_day AS (
        SELECT
          l.partner_id,
          substr(s.ts, 1, 10) AS day,
          s.link_id,
          MAX(s.clicks_count) AS clicks
        FROM snapshots s
        JOIN links l ON l.id = s.link_id
        WHERE s.ts >= datetime('now', '-7 days')
          ${creator ? "AND l.creator = ?" : ""}
          AND l.partner_id IN (${rows.map(() => "?").join(",") || "NULL"})
        GROUP BY l.partner_id, day, s.link_id
      )
      SELECT partner_id, day, SUM(clicks) AS clicks
      FROM per_day
      GROUP BY partner_id, day
      ORDER BY partner_id, day`;
    const sparkParams = creator
      ? [creator, ...rows.map((r) => r.id)]
      : rows.map((r) => r.id);
    const sparkRows = rows.length > 0
      ? db.prepare(sparkSql).all(...sparkParams) as Array<{
          partner_id: number;
          day: string;
          clicks: number;
        }>
      : [];

    /* === Stitching: links → creator → partner === */
    /* Группируем ссылки по (partner_id, creator) */
    const linksMap = new Map<string, typeof linksRows>();
    for (const l of linksRows) {
      const k = `${l.partner_id}:${l.creator}`;
      if (!linksMap.has(k)) linksMap.set(k, []);
      linksMap.get(k)!.push(l);
    }

    const byCreatorMap = new Map<number, Array<typeof breakdown[number] & { links: typeof linksRows }>>();
    for (const b of breakdown) {
      if (!byCreatorMap.has(b.partner_id)) byCreatorMap.set(b.partner_id, []);
      byCreatorMap.get(b.partner_id)!.push({
        ...b,
        links: linksMap.get(`${b.partner_id}:${b.creator}`) ?? [],
      });
    }
    const sparkMap = new Map<number, Array<{ day: string; clicks: number }>>();
    for (const s of sparkRows) {
      if (!sparkMap.has(s.partner_id)) sparkMap.set(s.partner_id, []);
      sparkMap.get(s.partner_id)!.push({ day: s.day, clicks: s.clicks });
    }

    const enriched = rows.map((r) => ({
      ...r,
      by_creator: byCreatorMap.get(r.id) ?? [],
      sparkline: sparkMap.get(r.id) ?? [],
    }));

    return { data: enriched };
  }

  /**
   * Period mode — снэпшоты delta в окне [from..to].
   * Считаем clicks/subs/spenders/revenue как ПРИРОСТ за период.
   * Payout пересчитывается per-link по приросту.
   */
  async function periodMode(db: Database.Database, from: string, to: string, creator?: string) {
    const deltas = periodLinkDelta(db, from, to)
      .filter((l) => !creator || l.creator === creator);

    /* Считаем payout per-link по формуле gross-subs × CPF / revenue × revshare */
    const linkPayout = (l: typeof deltas[number]): number => {
      const cpf = l.cpf_paid ?? l.cpf_free ?? 0;
      const cpfP = l.subs * cpf;
      const revP = (l.revshare_pct ?? 0) * l.revenue;
      if (cpf > 0 && l.revshare_pct != null) return Math.max(cpfP, revP);
      if (l.revshare_pct != null) return revP;
      return cpfP;
    };

    /* Группируем deltas → partner */
    const byPartner = new Map<number, {
      links_count: number;
      clicks: number;
      subs: number;
      spenders: number;
      revenue: number;
      payout: number;
    }>();
    for (const d of deltas) {
      const cur = byPartner.get(d.partner_id) ?? { links_count: 0, clicks: 0, subs: 0, spenders: 0, revenue: 0, payout: 0 };
      cur.links_count += 1;
      cur.clicks += d.clicks;
      cur.subs += d.subs;
      cur.spenders += d.spenders;
      cur.revenue += d.revenue;
      cur.payout += linkPayout(d);
      byPartner.set(d.partner_id, cur);
    }

    /* Группируем deltas → (partner, creator) для by_creator */
    const byPartnerCreator = new Map<string, { creator: string; links: typeof deltas; agg: { clicks: number; subs: number; spenders: number; revenue: number; payout: number } }>();
    for (const d of deltas) {
      const k = `${d.partner_id}:${d.creator}`;
      const cur = byPartnerCreator.get(k) ?? {
        creator: d.creator,
        links: [] as typeof deltas,
        agg: { clicks: 0, subs: 0, spenders: 0, revenue: 0, payout: 0 },
      };
      cur.links.push(d);
      cur.agg.clicks += d.clicks;
      cur.agg.subs += d.subs;
      cur.agg.spenders += d.spenders;
      cur.agg.revenue += d.revenue;
      cur.agg.payout += linkPayout(d);
      byPartnerCreator.set(k, cur);
    }

    /* Все партнёры (даже с 0 в периоде — пользователь просил всех) */
    const partners = db
      .prepare(`SELECT p.id, p.display_name, p.glossary_name, p.telegram, p.type, p.source, p.monthly_fee, p.notes FROM partners p ORDER BY p.display_name COLLATE NOCASE`)
      .all() as Array<{
        id: number; display_name: string; glossary_name: string; telegram: string | null;
        type: string | null; source: string | null; monthly_fee: number | null; notes: string | null;
      }>;

    /* Линки для drill-down — выводим только те у которых был >0 в окне */
    const linksByPartner = new Map<number, ReturnType<typeof rebuildLinkRow>[]>();
    for (const d of deltas) {
      const arr = linksByPartner.get(d.partner_id) ?? [];
      arr.push(rebuildLinkRow(d, linkPayout(d)));
      linksByPartner.set(d.partner_id, arr);
    }

    return {
      data: partners.map((p) => {
        const agg = byPartner.get(p.id);
        const byCreator: Array<{
          partner_id: number; creator: string; links_count: number;
          clicks_total: number; subs_total: number; spenders_total: number;
          revenue_total: number; payout_total: number;
          links: ReturnType<typeof rebuildLinkRow>[];
        }> = [];
        for (const [k, v] of byPartnerCreator) {
          if (!k.startsWith(`${p.id}:`)) continue;
          byCreator.push({
            partner_id: p.id,
            creator: v.creator,
            links_count: v.links.length,
            clicks_total: v.agg.clicks,
            subs_total: v.agg.subs,
            spenders_total: v.agg.spenders,
            revenue_total: v.agg.revenue,
            payout_total: v.agg.payout,
            links: v.links.map((l) => rebuildLinkRow(l, linkPayout(l))),
          });
        }
        return {
          ...p,
          links_count: agg?.links_count ?? 0,
          clicks_total: agg?.clicks ?? 0,
          subs_total: agg?.subs ?? 0,
          spenders_total: agg?.spenders ?? 0,
          revenue_total: agg?.revenue ?? 0,
          payout_total: agg?.payout ?? 0,
          last_synced_at: null,
          by_creator: byCreator,
          sparkline: [],
        };
      }),
      period: { from, to },
    };
  }

  /** Стандартный вид одной link-строки для frontend (совпадает с classicMode форматом). */
  function rebuildLinkRow(d: ReturnType<typeof periodLinkDelta>[number], payout: number) {
    return {
      partner_id: d.partner_id,
      creator: d.creator,
      id: d.link_id,
      campaign_code: d.campaign_code,
      of_url: d.of_url,
      of_created_at: d.of_created_at,
      cpf_free: d.cpf_free,
      cpf_paid: d.cpf_paid,
      revshare_pct: d.revshare_pct,
      clicks_count: d.clicks,
      subscribers_count: d.subs,
      spenders_count: d.spenders,
      revenue_total: d.revenue,
      payout_total: payout,
    };
  }

  /**
   * GET /api/partners/:id?creator=<name>
   * Карточка партнёра + его ссылки.
   * Если указан creator — отдаём только его ссылки для этой модели.
   */
  app.get<{ Params: { id: string }; Querystring: { creator?: string } }>(
    "/api/partners/:id",
    async (req, reply) => {
      const db = getDb();
      const id = Number(req.params.id);
      const creator = req.query.creator?.trim();

      const partner = db.prepare(`SELECT * FROM partners WHERE id = ?`).get(id);
      if (!partner) {
        reply.code(404);
        return { error: "Partner not found" };
      }
      const links = creator
        ? db
            .prepare(
              `SELECT * FROM links WHERE partner_id = ? AND creator = ? ORDER BY campaign_code`,
            )
            .all(id, creator)
        : db
            .prepare(
              `SELECT * FROM links WHERE partner_id = ? ORDER BY creator, campaign_code`,
            )
            .all(id);
      return { data: { partner, links } };
    },
  );

  /**
   * PATCH /api/partners/:id
   * Редактирование полей, которых нет в Glossary: monthly_fee, notes.
   * (type/source — read-only, источник истины = Glossary)
   */
  app.patch<{
    Params: { id: string };
    Body: {
      monthly_fee?: number | null;
      notes?: string | null;
    };
  }>("/api/partners/:id", async (req, reply) => {
    const db = getDb();
    const id = Number(req.params.id);
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of ["monthly_fee", "notes"] as const) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(req.body[key] ?? null);
      }
    }
    if (fields.length === 0) {
      reply.code(400);
      return { error: "No fields to update" };
    }
    fields.push(`updated_at = datetime('now')`);
    values.push(id);
    const result = db
      .prepare(`UPDATE partners SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    if (result.changes === 0) {
      reply.code(404);
      return { error: "Partner not found" };
    }
    const partner = db.prepare(`SELECT * FROM partners WHERE id = ?`).get(id);
    return { data: partner };
  });
}
