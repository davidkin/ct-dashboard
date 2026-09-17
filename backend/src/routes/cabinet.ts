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

      /* Тотал за ВСЮ жизнь ссылки — из кумулятивных счётчиков на самом линке,
         не из посуточного отчёта. Нужно для трафика, который случился ДО того
         как у партнёра включился посуточный снэпшот (report.rows тогда просто
         не может его показать — дельты считаются только вперёд от первого
         снимка, задним числом не восстановить). Формула payout — та же CASE,
         что в /api/partners (partners.ts classicMode), для консистентности. */
      const lifetimeLinks = db
        .prepare(
          `SELECT
             l.id, l.creator, l.campaign_code,
             COALESCE(l.clicks_count, 0)      AS clicks,
             COALESCE(l.subscribers_count, 0) AS fans,
             (CASE
                WHEN l.revshare_pct IS NOT NULL AND COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                  THEN MAX(COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free), COALESCE(l.revenue_total, 0) * l.revshare_pct)
                WHEN l.revshare_pct IS NOT NULL
                  THEN COALESCE(l.revenue_total, 0) * l.revshare_pct
                WHEN COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                  THEN COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free)
                ELSE 0
              END) AS payout
           FROM links l
           WHERE l.partner_id = ?
           ORDER BY l.creator, l.campaign_code COLLATE NOCASE`,
        )
        .all(partner.id) as Array<{ id: number; creator: string; campaign_code: string; clicks: number; fans: number; payout: number }>;
      const lifetimeTotal = lifetimeLinks.reduce(
        (acc, l) => ({ clicks: acc.clicks + l.clicks, fans: acc.fans + l.fans, payout: acc.payout + l.payout }),
        { clicks: 0, fans: 0, payout: 0 },
      );

      return {
        data: {
          partner: { id: partner.id, display_name: partner.display_name, telegram: partner.telegram },
          report,
          lifetime: { links: lifetimeLinks, total: lifetimeTotal },
        },
      };
    },
  );
}
