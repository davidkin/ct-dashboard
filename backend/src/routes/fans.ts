import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { fanTimeline } from "../fans/attribution";
import { reconcileFromCache } from "../fans/backfill";

/**
 * Fan timeline + ручная реконсиляция + отчёт по расходу API.
 */
export async function registerFanRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/fans/:id", async (req, reply) => {
    const timeline = fanTimeline(getDb(), Number(req.params.id));
    if (!timeline) {
      reply.code(404);
      return { error: "Fan not found" };
    }
    return { data: timeline };
  });

  /**
   * POST /api/sync/fans
   * Ручная реконсиляция fan-ledger из локального кэша (link_subscribers/link_spenders).
   * Кредиты OF не тратит. Живой backfill из OF — отдельный осознанный шаг (Phase 2).
   */
  app.post("/api/sync/fans", async () => {
    return { data: reconcileFromCache(getDb()) };
  });

  app.get<{ Querystring: { days?: string } }>("/api/api-usage", async (req) => {
    const db = getDb();
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));

    const creditsToday = (
      db
        .prepare(
          `SELECT COALESCE(SUM(credits_used), 0) AS credits, COALESCE(SUM(requests_count), 0) AS requests
           FROM api_usage_log WHERE started_at >= datetime('now', 'start of day')`,
        )
        .get() as { credits: number; requests: number }
    );
    const creditsMonth = (
      db
        .prepare(
          `SELECT COALESCE(SUM(credits_used), 0) AS credits, COALESCE(SUM(requests_count), 0) AS requests
           FROM api_usage_log WHERE started_at >= datetime('now', 'start of month')`,
        )
        .get() as { credits: number; requests: number }
    );
    const bySource = db
      .prepare(
        `SELECT source,
                COUNT(*) AS calls,
                COALESCE(SUM(requests_count), 0) AS requests,
                COALESCE(SUM(credits_used), 0) AS credits,
                COALESCE(SUM(items_processed), 0) AS items
         FROM api_usage_log
         WHERE started_at >= datetime('now', ?)
         GROUP BY source ORDER BY calls DESC`,
      )
      .all(`-${days} days`);
    const recent = db
      .prepare(`SELECT * FROM api_usage_log ORDER BY started_at DESC LIMIT 20`)
      .all();

    return {
      data: {
        credits_today: creditsToday.credits,
        requests_today: creditsToday.requests,
        credits_month: creditsMonth.credits,
        requests_month: creditsMonth.requests,
        by_source: bySource,
        recent,
      },
    };
  });

  /**
   * GET /api/identity/conflicts
   * Safety-метрика перед live VIP backfill: сколько фанов склеено по id (exact cross-account),
   * сколько inferred-матчей по username, и где один username маппится на >1 of_fan_id.
   */
  app.get("/api/identity/conflicts", async () => {
    const db = getDb();
    const exactCrossAccount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT fan_id FROM fan_identities
             WHERE of_account_id IS NOT NULL
             GROUP BY fan_id HAVING COUNT(DISTINCT of_account_id) > 1
           )`,
        )
        .get() as { n: number }
    ).n;
    const inferredUsernameMatches = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fan_identity_matches
           WHERE match_method = 'same_username_same_model_group'`,
        )
        .get() as { n: number }
    ).n;
    const usernameIdConflicts = db
      .prepare(
        `SELECT normalized_username, COUNT(DISTINCT of_fan_id) AS id_count
         FROM fan_identities
         WHERE normalized_username IS NOT NULL AND of_fan_id IS NOT NULL
         GROUP BY normalized_username HAVING COUNT(DISTINCT of_fan_id) > 1
         ORDER BY id_count DESC LIMIT 50`,
      )
      .all() as Array<{ normalized_username: string; id_count: number }>;
    return {
      data: {
        exact_cross_account_merges: exactCrossAccount,
        inferred_username_matches: inferredUsernameMatches,
        username_id_conflicts: usernameIdConflicts.length,
        username_id_conflict_samples: usernameIdConflicts,
        note: "Перед live VIP backfill: merges должны расти по of_fan_id (exact), а не по username; username_id_conflicts разбирать вручную.",
      },
    };
  });
}
