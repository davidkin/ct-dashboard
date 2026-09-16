/**
 * GET /api/reply-stats?partner_id=&creator=&from=&to=
 *
 * Конверсия "фан ответил на приветку" — читает готовые строки из
 * fan_reply_stats (см. src/om/reply-stats-worker.ts), никаких живых запросов
 * к OM на чтении. from/to фильтруют по дате подписки фана (om_subscribed_at),
 * по умолчанию последние 30 дней, как остальная аналитика.
 */
import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { todayLocal, addDays } from "../lib/tz";

interface Query {
  partner_id?: string;
  creator?: string;
  from?: string;
  to?: string;
}

interface StatRow {
  campaign_code: string;
  has_greeting: number;
  om_error: number;
  replied: number;
  reply_seconds: number | null;
}

export async function registerReplyStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/api/reply-stats", async (req) => {
    const db = getDb();
    const to = req.query.to || todayLocal();
    const from = req.query.from || addDays(to, -29);
    const partnerId = req.query.partner_id ? Number(req.query.partner_id) : null;
    const creator = req.query.creator || null;

    const conditions: string[] = ["ls.om_subscribed_at >= ?", "ls.om_subscribed_at < ?"];
    const params: (string | number)[] = [from, addDays(to, 1)];
    if (partnerId != null && Number.isFinite(partnerId)) {
      conditions.push("l.partner_id = ?");
      params.push(partnerId);
    }
    if (creator) {
      conditions.push("l.creator = ?");
      params.push(creator);
    }

    const rows = db
      .prepare(
        `SELECT l.campaign_code, frs.has_greeting, frs.om_error, frs.replied, frs.reply_seconds
         FROM fan_reply_stats frs
         JOIN link_subscribers ls ON ls.link_id = frs.link_id AND ls.of_fan_id = frs.of_fan_id
         JOIN links l ON l.id = frs.link_id
         WHERE ${conditions.join(" AND ")}`,
      )
      .all(...params) as StatRow[];

    const eligibleCountRow = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM link_subscribers ls JOIN links l ON l.id = ls.link_id
         WHERE ls.of_fan_id IS NOT NULL AND ${conditions.join(" AND ")}
           AND ls.om_subscribed_at <= datetime('now', '-3 days')`,
      )
      .get(...params) as { n: number };

    const valid = rows.filter((r) => r.has_greeting === 1 && r.om_error === 0);
    const replied = valid.filter((r) => r.replied === 1);
    const pct = valid.length ? (replied.length / valid.length) * 100 : null;
    const times = replied
      .map((r) => r.reply_seconds)
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : null;
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;

    const byCampaign = new Map<string, { total: number; replied: number }>();
    for (const r of valid) {
      const e = byCampaign.get(r.campaign_code) ?? { total: 0, replied: 0 };
      e.total++;
      if (r.replied === 1) e.replied++;
      byCampaign.set(r.campaign_code, e);
    }
    const campaigns = [...byCampaign.entries()]
      .map(([campaign_code, v]) => ({
        campaign_code,
        total: v.total,
        replied: v.replied,
        pct: (v.replied / v.total) * 100,
      }))
      .sort((a, b) => b.total - a.total);

    return {
      data: {
        from,
        to,
        partner_id: partnerId,
        creator,
        checked: rows.length,
        eligible: eligibleCountRow.n,
        pending: Math.max(0, eligibleCountRow.n - rows.length),
        valid: valid.length,
        replied: replied.length,
        pct,
        median_reply_seconds: median,
        avg_reply_seconds: avg,
        campaigns,
      },
    };
  });
}
