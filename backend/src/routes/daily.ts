import { FastifyInstance } from "fastify";
import { buildDailyReport } from "../daily/report";
import { captureDailyClicks } from "../daily/capture";
import { importTrafficSheet } from "../daily/sheet-import";
import { todayLocal, addDays } from "../lib/tz";

export async function registerDailyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/daily-tracking?creator=&from=&to=&all=
   * Дневной трекинг (как ручная таблица): строки = дни, колонки = компании.
   * from/to — YYYY-MM-DD в TRACKING_TZ. По умолчанию последние 30 дней.
   * all=1 — показывать и компании без активности в периоде.
   */
  app.get<{ Querystring: { creator?: string; from?: string; to?: string; all?: string; partner?: string } }>(
    "/api/daily-tracking",
    async (req) => {
      const to = req.query.to || todayLocal();
      const from = req.query.from || addDays(to, -29);
      const partnerNum = req.query.partner ? Number(req.query.partner) : null;
      const report = buildDailyReport({
        creator: req.query.creator || null,
        from,
        to,
        partner: Number.isFinite(partnerNum) ? partnerNum : null,
        includeEmpty: req.query.all === "1",
      });
      return { data: report };
    },
  );

  /**
   * POST /api/daily-tracking/capture
   * Ручной снимок: OM sync (реальные даты сабов) + накопительный счётчик кликов
   * за сегодня. Нужен для теста/бэкфилла, не дожидаясь ночного джоба.
   */
  app.post("/api/daily-tracking/capture", async (_req, reply) => {
    if (!process.env.ONLYMONSTER_TOKEN) {
      reply.code(503);
      return { error: "ONLYMONSTER_TOKEN not configured" };
    }
    try {
      const res = await captureDailyClicks({ runSync: true });
      return { data: res };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * POST /api/daily-tracking/import-sheet
   * Точный снимок ручной таблицы Traffic Tracking (клики + фаны) → daily_sheet_stats.
   * Эти значения перебивают OM-derived в отчёте, чтобы цифры совпадали с таблицей.
   */
  app.post("/api/daily-tracking/import-sheet", async (_req, reply) => {
    if (!process.env.GOOGLE_CREDENTIALS_PATH) {
      reply.code(503);
      return { error: "GOOGLE_CREDENTIALS_PATH not configured" };
    }
    try {
      const results = await importTrafficSheet();
      return { data: results };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}
