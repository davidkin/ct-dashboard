import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";

interface TrendsQuery {
  days?: string;
  creator?: string;
  start?: string;
  end?: string;
}

interface TrendRange {
  days: number;
  custom: boolean;
  start?: string;
  end?: string;
  priorStart?: string;
  priorEnd?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!DATE_RE.test(trimmed)) return undefined;
  const date = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function addDays(dateOnly: string, amount: number): string {
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function inclusiveDays(start: string, end: string): number {
  const startMs = new Date(`${start}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${end}T00:00:00.000Z`).getTime();
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function resolveRange(query: TrendsQuery): TrendRange | { error: string } {
  const parsedDays = Number(query.days ?? 7);
  const days = Number.isFinite(parsedDays)
    ? Math.min(90, Math.max(1, parsedDays))
    : 7;
  const requestedStart = normalizeDate(query.start);
  const requestedEnd = normalizeDate(query.end);

  if ((query.start && !requestedStart) || (query.end && !requestedEnd)) {
    return { error: "start/end must use YYYY-MM-DD" };
  }

  if (!requestedStart && !requestedEnd) {
    return { days, custom: false };
  }

  const today = new Date().toISOString().slice(0, 10);
  const end = requestedEnd ?? today;
  const start = requestedStart ?? addDays(end, -(days - 1));

  if (start > end) {
    return { error: "start must be earlier than or equal to end" };
  }

  const rangeDays = inclusiveDays(start, end);
  const priorEnd = addDays(start, -1);
  const priorStart = addDays(priorEnd, -(rangeDays - 1));

  return {
    days: rangeDays,
    custom: true,
    start,
    end,
    priorStart,
    priorEnd,
  };
}

/**
 * GET /api/trends?days=7
 * Per-partner сравнение «текущий период» vs «прошлый период такой же длины».
 * Считается из snapshots (абсолютные значения), delta = end - start.
 *
 * Если snapshot-ов меньше чем `days`, дельта может быть некорректной — фронт
 * должен показать пояснение «нужно ≥N дней истории».
 */
export async function registerTrendsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: TrendsQuery }>("/api/trends", async (req, reply) => {
    const db = getDb();
    const range = resolveRange(req.query);
    if ("error" in range) {
      return reply.code(400).send({ error: range.error });
    }

    const creator = req.query.creator?.trim();
    const creatorClause = creator ? "AND l.creator = ?" : "";
    const currentWhere = range.custom
      ? "s.ts >= datetime(?) AND s.ts < datetime(?, '+1 day')"
      : "s.ts >= datetime('now', ?)";
    const priorWhere = range.custom
      ? "s.ts >= datetime(?) AND s.ts < datetime(?, '+1 day')"
      : "s.ts >= datetime('now', ?) AND s.ts < datetime('now', ?)";
    const rangeParams = range.custom
      ? [range.start!, range.end!, range.priorStart!, range.priorEnd!]
      : [`-${range.days} days`, `-${range.days * 2} days`, `-${range.days} days`];

    /*
     * Для каждого партнёра:
     *   current = SUM по всем ссылкам последнего snapshot-а в последние `days` дней
     *   prior   = SUM по всем ссылкам последнего snapshot-а в предыдущие `days` дней
     */
    const rows = db
      .prepare(
        `
        WITH
          current_snaps AS (
            SELECT s.link_id,
                   MAX(s.revenue_total)     AS rev,
                   MAX(s.subscribers_count) AS subs,
                   MAX(s.spenders_count)    AS spenders,
                   MAX(s.clicks_count)      AS clicks
            FROM snapshots s
            WHERE ${currentWhere}
            GROUP BY s.link_id
          ),
          prior_snaps AS (
            SELECT s.link_id,
                   MAX(s.revenue_total)     AS rev,
                   MAX(s.subscribers_count) AS subs,
                   MAX(s.spenders_count)    AS spenders,
                   MAX(s.clicks_count)      AS clicks
            FROM snapshots s
            WHERE ${priorWhere}
            GROUP BY s.link_id
          ),
          current_per_partner AS (
            SELECT l.partner_id,
                   SUM(c.rev)    AS rev,
                   SUM(c.subs)   AS subs,
                   SUM(c.spenders) AS spenders,
                   SUM(c.clicks) AS clicks,
                   SUM(
                     CASE
                       WHEN l.revshare_pct IS NOT NULL AND COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                         THEN MAX(COALESCE(c.subs, 0) * COALESCE(l.cpf_paid, l.cpf_free), COALESCE(c.rev, 0) * l.revshare_pct)
                       WHEN l.revshare_pct IS NOT NULL
                         THEN COALESCE(c.rev, 0) * l.revshare_pct
                       WHEN COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                         THEN COALESCE(c.subs, 0) * COALESCE(l.cpf_paid, l.cpf_free)
                       ELSE 0
                     END
                   ) AS payout
            FROM current_snaps c JOIN links l ON l.id = c.link_id ${creatorClause}
            GROUP BY l.partner_id
          ),
          prior_per_partner AS (
            SELECT l.partner_id,
                   SUM(p.rev)    AS rev,
                   SUM(p.subs)   AS subs,
                   SUM(p.spenders) AS spenders,
                   SUM(p.clicks) AS clicks,
                   SUM(
                     CASE
                       WHEN l.revshare_pct IS NOT NULL AND COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                         THEN MAX(COALESCE(p.subs, 0) * COALESCE(l.cpf_paid, l.cpf_free), COALESCE(p.rev, 0) * l.revshare_pct)
                       WHEN l.revshare_pct IS NOT NULL
                         THEN COALESCE(p.rev, 0) * l.revshare_pct
                       WHEN COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                         THEN COALESCE(p.subs, 0) * COALESCE(l.cpf_paid, l.cpf_free)
                       ELSE 0
                     END
                   ) AS payout
            FROM prior_snaps p JOIN links l ON l.id = p.link_id ${creatorClause}
            GROUP BY l.partner_id
          )
        SELECT
          p.id, p.display_name,
          COALESCE(cur.rev,    0) AS curr_rev,
          COALESCE(cur.subs,   0) AS curr_subs,
          COALESCE(cur.spenders, 0) AS curr_spenders,
          COALESCE(cur.clicks, 0) AS curr_clicks,
          COALESCE(cur.payout, 0) AS curr_payout,
          COALESCE(pr.rev,    0) AS prior_rev,
          COALESCE(pr.subs,   0) AS prior_subs,
          COALESCE(pr.spenders, 0) AS prior_spenders,
          COALESCE(pr.clicks, 0) AS prior_clicks,
          COALESCE(pr.payout, 0) AS prior_payout
        FROM partners p
        LEFT JOIN current_per_partner cur ON cur.partner_id = p.id
        LEFT JOIN prior_per_partner   pr  ON pr.partner_id = p.id
        WHERE COALESCE(cur.clicks, 0) > 0 OR COALESCE(pr.clicks, 0) > 0
        `,
      )
      .all(
        ...[
          ...rangeParams,
          ...(creator ? [creator, creator] : []),
        ],
      ) as Array<{
        id: number;
        display_name: string;
        curr_rev: number; curr_subs: number; curr_spenders: number; curr_clicks: number; curr_payout: number;
        prior_rev: number; prior_subs: number; prior_spenders: number; prior_clicks: number; prior_payout: number;
      }>;

    /*
     * Считаем сколько разных дней есть в snapshots — фронт по этому решит,
     * показывать «нужно больше истории» или нет.
     */
    const span = db
      .prepare(
        `SELECT
           COUNT(DISTINCT substr(s.ts, 1, 10)) AS distinct_days,
           MIN(s.ts) AS first_ts,
           MAX(s.ts) AS last_ts
         FROM snapshots s
         JOIN links l ON l.id = s.link_id
         WHERE (? IS NULL OR l.creator = ?)`,
      )
      .get(creator ?? null, creator ?? null) as { distinct_days: number; first_ts: string | null; last_ts: string | null };

    const data = rows.map((r) => ({
      id: r.id,
      display_name: r.display_name,
      current: { revenue: r.curr_rev, subs: r.curr_subs, spenders: r.curr_spenders, clicks: r.curr_clicks, payout: r.curr_payout },
      prior: { revenue: r.prior_rev, subs: r.prior_subs, spenders: r.prior_spenders, clicks: r.prior_clicks, payout: r.prior_payout },
      delta: {
        revenue: r.curr_rev - r.prior_rev,
        subs: r.curr_subs - r.prior_subs,
        spenders: r.curr_spenders - r.prior_spenders,
        clicks: r.curr_clicks - r.prior_clicks,
        payout: r.curr_payout - r.prior_payout,
      },
      delta_pct: {
        revenue: r.prior_rev > 0 ? (r.curr_rev - r.prior_rev) / r.prior_rev : null,
        subs: r.prior_subs > 0 ? (r.curr_subs - r.prior_subs) / r.prior_subs : null,
        spenders: r.prior_spenders > 0 ? (r.curr_spenders - r.prior_spenders) / r.prior_spenders : null,
        clicks: r.prior_clicks > 0 ? (r.curr_clicks - r.prior_clicks) / r.prior_clicks : null,
        payout: r.prior_payout > 0 ? (r.curr_payout - r.prior_payout) / r.prior_payout : null,
      },
    }));

    return {
      data,
      meta: {
        days: range.days,
        start: range.start,
        end: range.end,
        prior_start: range.priorStart,
        prior_end: range.priorEnd,
        history_days: span.distinct_days,
        first_snapshot: span.first_ts,
        last_snapshot: span.last_ts,
        enough_history: span.distinct_days >= range.days * 2,
      },
    };
  });
}
