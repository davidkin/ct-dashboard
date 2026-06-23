import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { listTrackingLinkSubscribers } from "../of/client";
import { syncAllCreators, syncCreator } from "../of/sync";

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/sync
   * Body (опц): { creator: "Nekoletta Free" }
   * Без body — синкаем все настроенные модели.
   * Возвращает результаты по каждой модели.
   */
  app.post<{ Body: { creator?: string } }>("/api/sync", async (req, reply) => {
    if (!process.env.ONLYFANSAPI_KEY) {
      reply.code(503);
      return { error: "ONLYFANSAPI_KEY not configured" };
    }
    try {
      const results = req.body?.creator
        ? [await syncCreator(req.body.creator)]
        : await syncAllCreators();
      return { data: { results } };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * POST /api/sync/all-subscribers
   *
   * Bulk-pull subscribers всех ссылок где OF API сообщает >0 subscribers.
   * Нужно для заполнения link_subscribers под ledger.
   *
   * Параметры query:
   *   force=1       — игнорировать кэш и тянуть даже если в БД свежие данные
   *   min_subs=N    — только ссылки где subscribers_count >= N (default 1)
   *
   * Не дёргает заново те ссылки где cache fresh (< 60 мин) если force=0.
   * 1 кредит на одну ссылку. ~109 кредитов для текущего стейта.
   */
  app.post<{ Querystring: { force?: string; min_subs?: string } }>(
    "/api/sync/all-subscribers",
    async (req, reply) => {
      if (!process.env.ONLYFANSAPI_KEY) {
        reply.code(503);
        return { error: "ONLYFANSAPI_KEY not configured" };
      }
      const db = getDb();
      const force = req.query.force === "1";
      const minSubs = Math.max(1, Number(req.query.min_subs ?? 1));

      const candidates = db
        .prepare(
          `SELECT l.id, l.of_account_id, l.of_tracking_link_id, l.campaign_code, l.subscribers_count,
                  (SELECT MAX(fetched_at) FROM link_subscribers WHERE link_id = l.id) AS last_fetch
           FROM links l
           WHERE l.of_account_id IS NOT NULL
             AND l.of_tracking_link_id IS NOT NULL
             AND COALESCE(l.subscribers_count, 0) >= ?
           ORDER BY l.subscribers_count DESC`,
        )
        .all(minSubs) as Array<{
          id: number;
          of_account_id: string;
          of_tracking_link_id: number;
          campaign_code: string;
          subscribers_count: number | null;
          last_fetch: string | null;
        }>;

      const startedAt = Date.now();
      const upsert = db.prepare(`
        INSERT INTO link_subscribers (link_id, of_fan_id, username, subscribed_at, is_active, first_seen_at, fetched_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(link_id, of_fan_id) DO UPDATE SET
          username      = excluded.username,
          subscribed_at = excluded.subscribed_at,
          is_active     = excluded.is_active,
          fetched_at    = datetime('now')
      `);

      let processed = 0;
      let skipped = 0;
      let fetched_fans = 0;
      const errors: Array<{ link_id: number; campaign_code: string; error: string }> = [];

      for (const link of candidates) {
        /* Скипаем свежий кэш (< 60 мин) если не force */
        if (!force && link.last_fetch) {
          const ageMs = Date.now() - new Date(link.last_fetch.replace(" ", "T") + "Z").getTime();
          if (ageMs < 60 * 60 * 1000) {
            skipped++;
            continue;
          }
        }
        try {
          const fresh = await listTrackingLinkSubscribers(
            link.of_account_id,
            link.of_tracking_link_id,
            100,
            0,
          );
          const tx = db.transaction(() => {
            for (const r of fresh) {
              upsert.run(
                link.id,
                String(r.id),
                r.username ?? null,
                r.subscribedByExpireDate ?? null,
                r.isActive ? 1 : 0,
              );
            }
          });
          tx();
          fetched_fans += fresh.length;
          processed++;
        } catch (err) {
          errors.push({
            link_id: link.id,
            campaign_code: link.campaign_code,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        data: {
          total_candidates: candidates.length,
          processed,
          skipped_fresh_cache: skipped,
          fans_pulled: fetched_fans,
          errors,
          duration_ms: Date.now() - startedAt,
        },
      };
    },
  );

  app.get("/api/sync/status", async () => {
    const db = getDb();
    const last = db
      .prepare(`SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 10`)
      .all();
    const linksWithMetrics = db
      .prepare(`SELECT COUNT(*) AS cnt FROM links WHERE last_synced_at IS NOT NULL`)
      .get() as { cnt: number };
    return {
      data: {
        recent: last,
        links_with_metrics: linksWithMetrics.cnt,
        of_api_configured: !!process.env.ONLYFANSAPI_KEY,
      },
    };
  });
}
