import { FastifyInstance } from "fastify";
import { buildDailyReport } from "../daily/report";
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
}
