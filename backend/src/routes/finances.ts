import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { syncExtraForAllCreators } from "../of/sync-extra";

/**
 * Endpoints для финансовых данных: chargebacks, transactions, payouts.
 * Триггерят свой sync отдельно (стоят отдельных кредитов в OF API),
 * либо отдают из БД-кэша.
 */
export async function registerFinanceRoutes(app: FastifyInstance): Promise<void> {
  /** POST /api/finance/sync — pull chargebacks/transactions/payouts для всех настроенных акков */
  app.post("/api/finance/sync", async (_req, reply) => {
    if (!process.env.ONLYFANSAPI_KEY) {
      reply.code(503);
      return { error: "ONLYFANSAPI_KEY not configured" };
    }
    try {
      const results = await syncExtraForAllCreators();
      return { data: { results } };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** GET /api/chargebacks?days=30 — список chargebacks. */
  app.get<{ Querystring: { days?: string } }>("/api/chargebacks", async (req) => {
    const db = getDb();
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
    const rows = db
      .prepare(
        `SELECT * FROM chargebacks
         WHERE COALESCE(occurred_at, fetched_at) >= datetime('now', ?)
         ORDER BY COALESCE(occurred_at, fetched_at) DESC`,
      )
      .all(`-${days} days`);
    return { data: rows };
  });

  /**
   * GET /api/transactions?days=30
   * Гранулярные транзакции (sub/tip/PPV/etc).
   */
  app.get<{ Querystring: { days?: string } }>("/api/transactions", async (req) => {
    const db = getDb();
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
    const rows = db
      .prepare(
        `SELECT * FROM transactions
         WHERE COALESCE(occurred_at, fetched_at) >= datetime('now', ?)
         ORDER BY COALESCE(occurred_at, fetched_at) DESC
         LIMIT 1000`,
      )
      .all(`-${days} days`);
    return { data: rows };
  });

  /** GET /api/payouts — выплаты OF → модель. */
  app.get("/api/payouts", async () => {
    const db = getDb();
    const rows = db
      .prepare(`SELECT * FROM payouts ORDER BY COALESCE(paid_at, requested_at, fetched_at) DESC`)
      .all();
    return { data: rows };
  });
}
