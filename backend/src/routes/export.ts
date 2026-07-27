import { FastifyInstance } from "fastify";
import { buildDailyReport } from "../daily/report";
import { buildAnalytics } from "../daily/analytics";
import { getDb } from "../db/index";
import { getOmLinkTotals, omTotalsCacheAgeMs } from "../om/totals";
import { todayLocal, addDays } from "../lib/tz";

/**
 * Read-only выгрузка для внешнего фетча (напр. ассистентом).
 * Защищено токеном EXPORT_TOKEN (в URL: ?key=...), в обход Basic-auth дашборда
 * (эндпоинт исключён из auth-хука в server.ts). Только GET, только чтение.
 */
export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      key?: string;
      creator?: string;
      from?: string;
      to?: string;
      all?: string;
      partner?: string;
      source?: string;
      sheet_only?: string;
      tier?: string;
    };
  }>("/api/export", async (req, reply) => {
    const token = process.env.EXPORT_TOKEN;
    if (!token) {
      reply.code(503);
      return { error: "EXPORT_TOKEN not configured" };
    }
    if (!req.query.key || req.query.key !== token) {
      reply.code(401);
      return { error: "invalid or missing key" };
    }

    const to = req.query.to || todayLocal();
    const from = req.query.from || addDays(to, -29);
    const partnerNum = req.query.partner ? Number(req.query.partner) : null;
    const report = buildDailyReport({
      creator: req.query.creator || null,
      from,
      to,
      partner: Number.isFinite(partnerNum) ? partnerNum : null,
      includeEmpty: req.query.all === "1",
      sheetOnly: req.query.sheet_only === "1",
      source: req.query.source === "combined" ? "combined" : undefined,
      tier: req.query.tier === "free" || req.query.tier === "paid" ? req.query.tier : undefined,
    });
    return { data: report };
  });

  /* Общая аналитика по всем партнёрам за период (главный экран). Тот же токен. */
  app.get<{ Querystring: { key?: string; from?: string; to?: string; tier?: string; sheet_only?: string } }>(
    "/api/export/analytics",
    async (req, reply) => {
      const token = process.env.EXPORT_TOKEN;
      if (!token) {
        reply.code(503);
        return { error: "EXPORT_TOKEN not configured" };
      }
      if (!req.query.key || req.query.key !== token) {
        reply.code(401);
        return { error: "invalid or missing key" };
      }
      const to = req.query.to || todayLocal();
      const from = req.query.from || addDays(to, -29);
      const tier = req.query.tier === "free" || req.query.tier === "paid" ? req.query.tier : undefined;
      return { data: buildAnalytics(from, to, tier, req.query.sheet_only === "1") };
    },
  );

  /* OM-тоталы кликов/фанов (единственная истина по тоталам) + сумма из ручной
     таблицы для сверки. Кэш OM ~10 мин. partner=<id> — скоуп по партнёру. */
  app.get<{ Querystring: { key?: string; partner?: string; refresh?: string } }>(
    "/api/export/om-totals",
    async (req, reply) => {
      const token = process.env.EXPORT_TOKEN;
      if (!token) {
        reply.code(503);
        return { error: "EXPORT_TOKEN not configured" };
      }
      if (!req.query.key || req.query.key !== token) {
        reply.code(401);
        return { error: "invalid or missing key" };
      }
      const om = await getOmLinkTotals(req.query.refresh === "1");
      const db = getDb();
      const partnerNum = req.query.partner ? Number(req.query.partner) : null;
      const partner = Number.isFinite(partnerNum) ? partnerNum : null;

      /* наши линки (+ сумма по ручной таблице = daily_sheet_stats) */
      const rows = db
        .prepare(
          `SELECT l.id AS link_id, l.campaign_code, l.partner_id,
                  COALESCE(s.clicks,0) AS sheet_clicks, COALESCE(s.fans,0) AS sheet_fans
             FROM links l
             LEFT JOIN (SELECT link_id, SUM(clicks) AS clicks, SUM(fans) AS fans
                          FROM daily_sheet_stats GROUP BY link_id) s ON s.link_id = l.id
            WHERE (@partner IS NULL OR l.partner_id = @partner)
              AND l.campaign_code IS NOT NULL AND l.campaign_code <> ''`,
        )
        .all({ partner }) as Array<{
          link_id: number; campaign_code: string; partner_id: number | null;
          sheet_clicks: number; sheet_fans: number;
        }>;

      const links = rows.map((r) => {
        const o = om.get(r.campaign_code);
        return {
          link_id: r.link_id,
          campaign_code: r.campaign_code,
          partner_id: r.partner_id,
          tracking_id: o?.tracking_id ?? null,
          om_clicks: o?.clicks ?? null,
          om_fans: o?.subscribers ?? null,
          sheet_clicks: r.sheet_clicks,
          sheet_fans: r.sheet_fans,
        };
      });

      const totals = links.reduce(
        (t, l) => ({
          om_clicks: t.om_clicks + (l.om_clicks ?? 0),
          om_fans: t.om_fans + (l.om_fans ?? 0),
          sheet_clicks: t.sheet_clicks + l.sheet_clicks,
          sheet_fans: t.sheet_fans + l.sheet_fans,
        }),
        { om_clicks: 0, om_fans: 0, sheet_clicks: 0, sheet_fans: 0 },
      );

      return { data: { totals, links, cache_age_ms: omTotalsCacheAgeMs() } };
    },
  );
}
