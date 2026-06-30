import { FastifyInstance } from "fastify";
import { buildDailyReport } from "../daily/report";
import { captureDailyClicks } from "../daily/capture";
import { todayLocal, addDays } from "../lib/tz";

export async function registerDailyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/daily-tracking?creator=&from=&to=&all=
   * Дневной трекинг (как ручная таблица): строки = дни, колонки = компании.
   * from/to — YYYY-MM-DD в TRACKING_TZ. По умолчанию последние 30 дней.
   * all=1 — показывать и компании без активности в периоде.
   */
  app.get<{ Querystring: { creator?: string; from?: string; to?: string; all?: string } }>(
    "/api/daily-tracking",
    async (req) => {
      const to = req.query.to || todayLocal();
      const from = req.query.from || addDays(to, -29);
      const report = buildDailyReport({
        creator: req.query.creator || null,
        from,
        to,
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
}
