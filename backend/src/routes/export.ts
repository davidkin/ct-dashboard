import { FastifyInstance } from "fastify";
import { buildDailyReport } from "../daily/report";
import { buildAnalytics } from "../daily/analytics";
import { getDb } from "../db/index";
import { getOmLinkTotals, omTotalsCacheAgeMs, omTotalsErrors, findOmTotal } from "../om/totals";
import { creatorsInModelGroup, getModelGroup, listModels } from "../config/creators";
import { todayLocal, addDays } from "../lib/tz";
import { getLastIntegrityReport, runIntegrityCheck } from "../daily/integrity";

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
      model?: string;
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
      model: req.query.model || null,
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

  /* Список моделей для переключателя в шапке. Тот же токен. */
  app.get<{ Querystring: { key?: string } }>("/api/export/models", async (req, reply) => {
    const token = process.env.EXPORT_TOKEN;
    if (!token) {
      reply.code(503);
      return { error: "EXPORT_TOKEN not configured" };
    }
    if (!req.query.key || req.query.key !== token) {
      reply.code(401);
      return { error: "invalid or missing key" };
    }
    const db = getDb();
    const counts = db
      .prepare(`SELECT creator, COUNT(*) AS n FROM links GROUP BY creator`)
      .all() as Array<{ creator: string; n: number }>;
    const linksByModel = new Map<string, number>();
    for (const c of counts) {
      const g = getModelGroup(c.creator);
      if (g) linksByModel.set(g, (linksByModel.get(g) ?? 0) + c.n);
    }
    return {
      data: listModels().map((m) => ({ ...m, links: linksByModel.get(m.group) ?? 0 })),
    };
  });

  /* Список партнёров для выпадашки. Раньше он был зашит в код фронта, из-за
     чего новые партнёры из глоссария в интерфейсе не появлялись.
     LEFT JOIN, а не JOIN: партнёр, заведённый в глоссарии, должен получить свою
     таблицу в «Трафике» сразу — ещё до того, как к нему привязали первую ссылку. */
  app.get<{ Querystring: { key?: string; model?: string } }>(
    "/api/export/partners",
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
      const model = req.query.model || null;
      const modelCreators = model ? JSON.stringify(creatorsInModelGroup(model)) : "[]";
      const rows = getDb()
        .prepare(
          `SELECT p.id, p.display_name, p.telegram,
                  COUNT(l.id) AS links,
                  COALESCE(SUM(CASE WHEN l.of_tracking_link_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS tracked,
                  (SELECT COALESCE(SUM(o.clicks),0) FROM daily_om_stats o
                    JOIN links l2 ON l2.id = o.link_id
                   WHERE l2.partner_id = p.id) AS clicks
             FROM partners p
             LEFT JOIN links l ON l.partner_id = p.id
                   AND (@model IS NULL OR l.creator IN (SELECT value FROM json_each(@modelCreators)))
            WHERE COALESCE(p.archived, 0) = 0
            GROUP BY p.id, p.display_name, p.telegram
            ORDER BY clicks DESC, p.display_name COLLATE NOCASE`,
        )
        .all({ model, modelCreators }) as Array<{
          id: number; display_name: string; telegram: string | null;
          links: number; tracked: number; clicks: number;
        }>;
      return { data: rows };
    },
  );

  /* Самопроверка данных. По умолчанию отдаёт последний сохранённый прогон
     (мгновенно), refresh=1 — гоняет заново с походом в OM. */
  app.get<{ Querystring: { key?: string; refresh?: string } }>(
    "/api/export/integrity",
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
      if (req.query.refresh === "1") {
        return { data: await runIntegrityCheck() };
      }
      const last = getLastIntegrityReport();
      if (!last) return { data: await runIntegrityCheck() };
      return { data: last };
    },
  );

  /* Общая аналитика по всем партнёрам за период (главный экран). Тот же токен. */
  app.get<{
    Querystring: { key?: string; from?: string; to?: string; tier?: string; sheet_only?: string; model?: string };
  }>(
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
      return { data: buildAnalytics(from, to, tier, req.query.sheet_only === "1", req.query.model || null) };
    },
  );

  /* OM-тоталы кликов/фанов (единственная истина по тоталам) + сумма из ручной
     таблицы для сверки. Кэш OM ~10 мин. partner=<id> — скоуп по партнёру. */
  app.get<{ Querystring: { key?: string; partner?: string; refresh?: string; model?: string } }>(
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
      const model = req.query.model || null;
      const modelCreators = model ? JSON.stringify(creatorsInModelGroup(model)) : "[]";

      /* наши линки + актуальный кумулятив кликов/фанов из дневных снимков
         дашборда (daily_link_clicks, последний захваченный день на линк) —
         НЕ из ручного листа daily_sheet_stats (он одноразовый и протухает). */
      const rows = db
        .prepare(
          `SELECT l.id AS link_id, l.campaign_code, l.partner_id, l.creator,
                  COALESCE(s.clicks,0) AS sheet_clicks, COALESCE(s.fans,0) AS sheet_fans
             FROM links l
             LEFT JOIN (SELECT d.link_id,
                               d.clicks_cumulative AS clicks,
                               COALESCE(d.fans_cumulative,0) AS fans
                          FROM daily_link_clicks d
                         WHERE d.day = (SELECT MAX(day) FROM daily_link_clicks d2
                                         WHERE d2.link_id = d.link_id)) s ON s.link_id = l.id
            WHERE (@partner IS NULL OR l.partner_id = @partner)
              AND (@model IS NULL OR l.creator IN (SELECT value FROM json_each(@modelCreators)))
              AND l.campaign_code IS NOT NULL AND l.campaign_code <> ''`,
        )
        .all({ partner, model, modelCreators }) as Array<{
          link_id: number; campaign_code: string; partner_id: number | null; creator: string;
          sheet_clicks: number; sheet_fans: number;
        }>;

      const links = rows.map((r) => {
        const o = findOmTotal(om, getModelGroup(r.creator), r.creator, r.campaign_code);
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

      /* om_errors — аккаунты, недоступные в OM (отвалившаяся модель): по ним
         сверка неполная, и молчать об этом нельзя. */
      return { data: { totals, links, cache_age_ms: omTotalsCacheAgeMs(), om_errors: omTotalsErrors() } };
    },
  );
}
