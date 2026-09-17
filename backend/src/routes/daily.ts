import { FastifyInstance } from "fastify";
import { buildDailyReport } from "../daily/report";
import { captureDailyClicks } from "../daily/capture";
import { importTrafficSheet } from "../daily/sheet-import";
import { todayLocal, addDays } from "../lib/tz";
import { canSeePartnerType } from "../lib/auth";
import { getDb } from "../db/index";

export async function registerDailyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/daily-tracking?creator=&from=&to=&all=
   * Дневной трекинг (как ручная таблица): строки = дни, колонки = компании.
   * from/to — YYYY-MM-DD в TRACKING_TZ. По умолчанию последние 30 дней.
   * all=1 — показывать и компании без активности в периоде.
   */
  app.get<{ Querystring: { creator?: string; from?: string; to?: string; all?: string; partner?: string; sheet_only?: string; source?: string; tier?: string } }>(
    "/api/daily-tracking",
    async (req, reply) => {
      const to = req.query.to || todayLocal();
      const from = req.query.from || addDays(to, -29);
      const partnerNum = req.query.partner ? Number(req.query.partner) : null;
      if (Number.isFinite(partnerNum) && partnerNum != null) {
        const partner = getDb().prepare(`SELECT type FROM partners WHERE id = ?`).get(partnerNum) as
          | { type: string | null }
          | undefined;
        if (partner && !canSeePartnerType(req.user, partner.type)) {
          reply.code(403);
          return { error: "Нет доступа к партнёрам этого типа" };
        }
      }
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
  app.post("/api/daily-tracking/import-sheet", async (req, reply) => {
    if (!process.env.GOOGLE_CREDENTIALS_PATH) {
      reply.code(503);
      return { error: "GOOGLE_CREDENTIALS_PATH not configured" };
    }
    /* ?models=Lily — импортировать табы только одной модели */
    const modelsParam = (req.query as { models?: string }).models;
    const models = modelsParam ? modelsParam.split(",").map((m) => m.trim()).filter(Boolean) : undefined;
    try {
      const results = await importTrafficSheet({ models });
      return { data: results };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}
