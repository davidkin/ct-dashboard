import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";

/**
 * GET /api/activity
 * Возвращает агрегированную по дням активность.
 * Источник — таблица snapshots (которая пишется при каждом sync).
 *
 * Параметры:
 *   days      — окно: 7, 30, 90 (default 30)
 *   start/end — кастомный диапазон YYYY-MM-DD (end включительно)
 *   partner_id — фильтр по партнёру
 *   creator   — фильтр по модели
 *
 * Поскольку snapshots сейчас содержит ABSOLUTE значения (а не deltas),
 * мы агрегируем как MAX за день — это «состояние на конец дня».
 * Возможен переход на deltas позже (для real-time per-day income).
 */
export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { days?: string; start?: string; end?: string; partner_id?: string; creator?: string };
  }>("/api/activity", async (req) => {
    const db = getDb();
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
    const start = normalizeDate(req.query.start);
    const end = normalizeDate(req.query.end);
    const partnerId = req.query.partner_id ? Number(req.query.partner_id) : null;
    const creator = req.query.creator?.trim();

    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (start || end) {
      if (start) {
        conds.push("s.ts >= datetime(?)");
        params.push(start);
      }
      if (end) {
        conds.push("s.ts < datetime(?, '+1 day')");
        params.push(end);
      }
    } else {
      conds.push("s.ts >= datetime('now', ?)");
      params.push(`-${days} days`);
    }
    if (partnerId) {
      conds.push("l.partner_id = ?");
      params.push(partnerId);
    }
    if (creator) {
      conds.push("l.creator = ?");
      params.push(creator);
    }

    const rows = db
      .prepare(
        `WITH latest_daily AS (
           SELECT
             substr(s.ts, 1, 10) AS day,
             s.link_id,
             s.clicks_count,
             s.subscribers_count,
             s.spenders_count,
             s.revenue_total,
             ROW_NUMBER() OVER (
               PARTITION BY substr(s.ts, 1, 10), s.link_id
               ORDER BY s.ts DESC, s.id DESC
             ) AS rn
           FROM snapshots s
           JOIN links l ON l.id = s.link_id
           WHERE ${conds.join(" AND ")}
         )
         SELECT
           day,
           SUM(clicks_count)      AS clicks,
           SUM(subscribers_count) AS subs,
           SUM(spenders_count)    AS spenders,
           SUM(revenue_total)     AS revenue
         FROM latest_daily
         WHERE rn = 1
         GROUP BY day
         ORDER BY day`,
      )
      .all(...params) as Array<{
        day: string;
        clicks: number | null;
        subs: number | null;
        spenders: number | null;
        revenue: number | null;
      }>;

    return { data: rows };
  });
}

function normalizeDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
