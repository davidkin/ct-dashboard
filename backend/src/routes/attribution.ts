import { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { getDb } from "../db/index";
import { linkReport, overview, partners } from "../fans/attribution";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface PeriodQuery { from?: string; to?: string }

function parsePeriod(q: PeriodQuery): { from: string; to: string } | null {
  if (!q.from || !q.to) return null;
  if (!DATE_RE.test(q.from) || !DATE_RE.test(q.to)) return null;
  return { from: `${q.from} 00:00:00`, to: `${q.to} 23:59:59` };
}

/**
 * Considera only first-touch фанов, попавших в [from..to] по first_touch_at.
 * Возвращает агрегат на партнёра: subs (first-touch в период), CPF, payout.
 * RevShare пока 0 (revenue нет).
 */
function partnersByPeriod(db: Database.Database, from: string, to: string) {
  const rows = db
    .prepare(
      `WITH period_touches AS (
         SELECT t.partner_id, t.link_id, t.fan_id
         FROM fan_link_touches t
         WHERE t.touch_role = 'first_touch'
           AND t.cpf_eligible = 1
           AND t.first_touch_at IS NOT NULL
           AND t.first_touch_at >= ?
           AND t.first_touch_at <= ?
       )
       SELECT
         p.id   AS partner_id,
         p.display_name,
         COALESCE(COUNT(pt.fan_id), 0) AS first_touch_fans,
         COALESCE(SUM(COALESCE(l.cpf_paid, l.cpf_free, 0)), 0) AS cpf_component
       FROM partners p
       LEFT JOIN period_touches pt ON pt.partner_id = p.id
       LEFT JOIN links l           ON l.id = pt.link_id
       GROUP BY p.id, p.display_name
       ORDER BY p.display_name COLLATE NOCASE`,
    )
    .all(from, to) as Array<{
      partner_id: number;
      display_name: string;
      first_touch_fans: number;
      cpf_component: number;
    }>;

  return rows.map((r) => ({
    partner_id: r.partner_id,
    display_name: r.display_name,
    first_touch_fans: r.first_touch_fans,
    repeat_touch_fans: 0,
    overlap_fans: 0,
    cpf_eligible_fans: r.first_touch_fans,
    cpf_component: Number(r.cpf_component) || 0,
    revshare_component: 0,
    payout_total: Number(r.cpf_component) || 0,
    free_to_vip_conversions: 0,
    gross_vip_revenue_from_free_fans: 0,
    agency_recoup_rate: null as number | null,
  }));
}

function partnerLinksByPeriod(db: Database.Database, partnerId: number, from: string, to: string) {
  const rows = db
    .prepare(
      `SELECT
         l.id                  AS link_id,
         l.partner_id,
         l.creator,
         l.campaign_code,
         l.of_url,
         l.subscribers_count   AS gross_subscribers,
         l.cpf_free, l.cpf_paid, l.revshare_pct,
         (
           SELECT COUNT(*) FROM fan_link_touches t
           WHERE t.link_id = l.id
             AND t.touch_role = 'first_touch'
             AND t.cpf_eligible = 1
             AND t.first_touch_at >= ? AND t.first_touch_at <= ?
         ) AS first_touch_fans,
         (
           SELECT COUNT(*) FROM fan_link_touches t
           WHERE t.link_id = l.id
             AND t.touch_role IN ('repeat_touch','overlap')
             AND t.first_touch_at >= ? AND t.first_touch_at <= ?
         ) AS repeat_overlap_fans
       FROM links l
       WHERE l.partner_id = ?
       ORDER BY l.creator, l.campaign_code`,
    )
    .all(from, to, from, to, partnerId) as Array<{
      link_id: number;
      partner_id: number;
      creator: string;
      campaign_code: string;
      of_url: string;
      gross_subscribers: number | null;
      cpf_free: number | null;
      cpf_paid: number | null;
      revshare_pct: number | null;
      first_touch_fans: number;
      repeat_overlap_fans: number;
    }>;

  return rows.map((r) => {
    const cpf = r.cpf_paid ?? r.cpf_free ?? 0;
    const cpfComp = r.first_touch_fans * cpf;
    return {
      link_id: r.link_id,
      campaign_code: r.campaign_code,
      of_url: r.of_url,
      creator: r.creator,
      partner_id: r.partner_id,
      gross_subscribers: r.gross_subscribers ?? 0,
      unique_fans: r.first_touch_fans + r.repeat_overlap_fans,
      first_touch_fans: r.first_touch_fans,
      repeat_overlap_fans: r.repeat_overlap_fans,
      spenders: 0,
      revenue: 0,
      attributed_purchases: 0,
      message_read_rate: null,
      reply_rate: null,
      payout_breakdown: {
        link_id: r.link_id,
        partner_id: r.partner_id,
        creator: r.creator,
        cpf_rate: cpf || null,
        revshare_pct: r.revshare_pct,
        cpf_eligible_fans: r.first_touch_fans,
        cpf_component: cpfComp,
        attributed_revenue: 0,
        revshare_component: 0,
        payout_total: cpfComp,
      },
    };
  });
}

/**
 * Attribution reports (read-only). Источник — fan-level ledger.
 * Payout считается authoritative в backend (fans/payout.ts), не во фронте.
 */
export async function registerAttributionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/attribution/overview", async () => {
    return { data: overview(getDb()) };
  });

  /**
   * GET /api/attribution/partners
   * Опциональные ?from=YYYY-MM-DD&to=YYYY-MM-DD — считать только first-touch
   * фанов, попавших в этот период.
   */
  app.get<{ Querystring: PeriodQuery }>("/api/attribution/partners", async (req) => {
    const db = getDb();
    const period = parsePeriod(req.query);
    if (period) {
      return { data: partnersByPeriod(db, period.from, period.to), period };
    }
    return { data: partners(db) };
  });

  app.get<{ Params: { id: string } }>("/api/attribution/links/:id", async (req, reply) => {
    const report = linkReport(getDb(), Number(req.params.id));
    if (!report) {
      reply.code(404);
      return { error: "Link not found" };
    }
    return { data: report };
  });

  /**
   * GET /api/attribution/partners/:id/links
   * Batch-возврат attribution-репортов по всем ссылкам партнёра — для drill-down в UI.
   * Использует тот же linkReport() что и single-link endpoint.
   */
  app.get<{ Params: { id: string }; Querystring: PeriodQuery }>(
    "/api/attribution/partners/:id/links",
    async (req) => {
      const partnerId = Number(req.params.id);
      const db = getDb();
      const period = parsePeriod(req.query);
      if (period) {
        return { data: partnerLinksByPeriod(db, partnerId, period.from, period.to), period };
      }
      const links = db
        .prepare(`SELECT id FROM links WHERE partner_id = ? ORDER BY creator, campaign_code`)
        .all(partnerId) as Array<{ id: number }>;
      const reports = links.map((l) => linkReport(db, l.id)).filter((r): r is NonNullable<typeof r> => r !== null);
      return { data: reports };
    },
  );
}
