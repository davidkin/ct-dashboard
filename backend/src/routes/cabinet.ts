/**
 * Личный кабинет траффера — read-only отчёт по одному партнёру, открывается
 * по секретной ссылке без логина. Ровно как shared report в OnlyMonster:
 * токен и есть авторизация, поэтому эндпоинт исключён из session-гейта в
 * server.ts, как и /api/export.
 */
import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { buildDailyReport } from "../daily/report";
import { todayLocal, addDays } from "../lib/tz";

export async function registerCabinetRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get<{ Params: { token: string }; Querystring: { from?: string; to?: string } }>(
    "/api/cabinet/:token",
    async (req, reply) => {
      const partner = db
        .prepare(`SELECT id, display_name, telegram FROM partners WHERE share_token = ?`)
        .get(req.params.token) as { id: number; display_name: string; telegram: string | null } | undefined;
      if (!partner) {
        reply.code(404);
        return { error: "Ссылка недействительна или отозвана" };
      }

      const to = req.query.to || todayLocal();
      const from = req.query.from || addDays(to, -29);
      const report = buildDailyReport({ creator: null, from, to, partner: partner.id, source: "combined" });

      return {
        data: {
          partner: { id: partner.id, display_name: partner.display_name, telegram: partner.telegram },
          report,
        },
      };
    },
  );
}
