import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { listTrackingLinkSpenders, listTrackingLinkSubscribers } from "../of/client";

/**
 * Per-link drill-down: подписавшиеся и платящие фаны.
 *
 * Стратегия кэширования:
 *   - Если в БД есть данные younger чем `cache_minutes` (по дефолту 60) — отдаём из БД.
 *   - Иначе тянем из OF API, обновляем БД, отдаём свежее.
 *   - `?refresh=1` форсирует pull независимо от возраста кэша.
 */
export async function registerLinksRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    "/api/links/:id/subscribers",
    async (req, reply) => {
      const id = Number(req.params.id);
      const refresh = req.query.refresh === "1";
      const db = getDb();
      const link = db
        .prepare(`SELECT id, of_account_id, of_tracking_link_id FROM links WHERE id = ?`)
        .get(id) as { id: number; of_account_id: string | null; of_tracking_link_id: number | null } | undefined;
      if (!link) { reply.code(404); return { error: "Link not found" }; }
      if (!link.of_account_id || !link.of_tracking_link_id) {
        reply.code(412);
        return { error: "Link has not been synced with OnlyFansAPI yet — wait for next sync." };
      }

      if (!refresh) {
        const cached = db
          .prepare(`SELECT * FROM link_subscribers WHERE link_id = ? AND fetched_at >= datetime('now', '-60 minutes')`)
          .all(id);
        if (cached.length > 0) return { data: cached, source: "cache" };
      }

      try {
        const fresh = await listTrackingLinkSubscribers(link.of_account_id, link.of_tracking_link_id, 100, 0);
        const stmt = db.prepare(`
          INSERT INTO link_subscribers (link_id, of_fan_id, username, subscribed_at, is_active, fetched_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(link_id, of_fan_id) DO UPDATE SET
            username      = excluded.username,
            subscribed_at = excluded.subscribed_at,
            is_active     = excluded.is_active,
            fetched_at    = datetime('now')
        `);
        const safeFresh = Array.isArray(fresh) ? fresh : [];
        const tx = db.transaction(() => {
          for (const r of safeFresh) {
            stmt.run(
              id,
              String(r.id),
              r.username ?? null,
              r.subscribedByExpireDate ?? null,
              r.isActive ? 1 : 0,
            );
          }
        });
        tx();
        const rows = db.prepare(`SELECT * FROM link_subscribers WHERE link_id = ?`).all(id);
        return { data: rows, source: "fresh", count: safeFresh.length };
      } catch (err) {
        reply.code(502);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { refresh?: string; min_spend?: string } }>(
    "/api/links/:id/spenders",
    async (req, reply) => {
      const id = Number(req.params.id);
      const refresh = req.query.refresh === "1";
      const minSpend = Number(req.query.min_spend ?? 1);
      const db = getDb();
      const link = db
        .prepare(`SELECT id, of_account_id, of_tracking_link_id FROM links WHERE id = ?`)
        .get(id) as { id: number; of_account_id: string | null; of_tracking_link_id: number | null } | undefined;
      if (!link) { reply.code(404); return { error: "Link not found" }; }
      if (!link.of_account_id || !link.of_tracking_link_id) {
        reply.code(412);
        return { error: "Link has not been synced with OnlyFansAPI yet — wait for next sync." };
      }

      if (!refresh) {
        const cached = db
          .prepare(`SELECT * FROM link_spenders WHERE link_id = ? AND fetched_at >= datetime('now', '-60 minutes') ORDER BY revenue_total DESC`)
          .all(id);
        if (cached.length > 0) return { data: cached, source: "cache" };
      }

      try {
        const fresh = await listTrackingLinkSpenders(link.of_account_id, link.of_tracking_link_id, 100, 0, minSpend);
        const stmt = db.prepare(`
          INSERT INTO link_spenders (link_id, of_fan_id, username, revenue_total, calculated_at, fetched_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(link_id, of_fan_id) DO UPDATE SET
            username       = excluded.username,
            revenue_total  = excluded.revenue_total,
            calculated_at  = excluded.calculated_at,
            fetched_at     = datetime('now')
        `);
        const safeFresh = Array.isArray(fresh) ? fresh : [];
        const tx = db.transaction(() => {
          for (const r of safeFresh) {
            stmt.run(id, r.onlyfans_id, r.username ?? null, r.revenue?.total ?? 0, r.revenue?.calculated_at ?? null);
          }
        });
        tx();
        const rows = db
          .prepare(`SELECT * FROM link_spenders WHERE link_id = ? ORDER BY revenue_total DESC`)
          .all(id);
        return { data: rows, source: "fresh", count: safeFresh.length };
      } catch (err) {
        reply.code(502);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
