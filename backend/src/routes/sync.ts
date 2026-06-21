import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
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
