/**
 * Аналитика по всем партнёрам за период — источник для главного экрана «Общая аналитика».
 *
 * Строится ПОВЕРХ buildDailyReport (та же «combined»-логика, что и «Таблица»),
 * поэтому цифры кликов/фанов/выплат согласованы с трафик-таблицей. Ничего не
 * пересчитываем заново: агрегируем ячейки отчёта по партнёру.
 *
 * Выручка (revenue) — best-effort: сумма транзакций OM, атрибутированных фанам
 * партнёрских линков за период. Нет данных → 0 (выплата всё равно точная).
 */
import { getDb } from "../db/index";
import { buildDailyReport } from "./report";
import { TRACKING_TZ, lastCompletedWeekStart } from "../lib/tz";

export interface PartnerAnalytics {
  partner_id: number;
  display_name: string;
  telegram: string | null;
  type: string | null;
  source: string | null;
  note: string | null;
  archived: boolean;
  active: boolean;
  clicks: number;
  fans: number;
  cr: number | null;
  revenue: number;
  payout: number;
  /** тренд дневного объёма фанов (последний день vs предыдущий), null если недостаточно данных */
  trend: number | null;
  payout_status: "pending" | "done";
}

export interface AnalyticsReport {
  from: string;
  to: string;
  tz: string;
  /** понедельник недели, за которую сейчас статусы выплат */
  week_start: string;
  kpi: { partners: number; clicks: number; fans: number; revenue: number; payout: number };
  daily: Array<{ day: string; clicks: number; fans: number }>;
  tiers: { free: { clicks: number; fans: number }; paid: { clicks: number; fans: number } };
  sources: Array<{ label: string; clicks: number; fans: number }>;
  partners: PartnerAnalytics[];
}

export function buildAnalytics(
  from: string,
  to: string,
  tier?: "free" | "paid",
  sheetOnly = false,
): AnalyticsReport {
  const db = getDb();
  const report = buildDailyReport({
    creator: null,
    from,
    to,
    source: sheetOnly ? undefined : "combined",
    sheetOnly,
    tier,
  });

  /* link_id → partner_id (по кампаниям отчёта) */
  const linkPartner = new Map<number, number | null>();
  for (const c of report.campaigns) linkPartner.set(c.link_id, c.partner_id);

  /* агрегаты по партнёру + дневные ряды (для тренда) */
  interface Agg { clicks: number; fans: number; payout: number; byDay: Map<string, number> }
  const agg = new Map<number, Agg>();
  const ensure = (pid: number): Agg => {
    let a = agg.get(pid);
    if (!a) { a = { clicks: 0, fans: 0, payout: 0, byDay: new Map() }; agg.set(pid, a); }
    return a;
  };
  const daily: Array<{ day: string; clicks: number; fans: number }> = [];
  for (const row of report.rows) {
    daily.push({ day: row.date, clicks: row.total.clicks ?? 0, fans: row.total.subs });
    for (const c of report.campaigns) {
      const pid = c.partner_id;
      if (pid == null) continue;
      const cell = row.cells[String(c.link_id)];
      if (!cell) continue;
      const a = ensure(pid);
      a.clicks += cell.clicks ?? 0;
      a.fans += cell.subs;
      a.payout += cell.payout;
      a.byDay.set(row.date, (a.byDay.get(row.date) ?? 0) + cell.subs);
    }
  }

  /* метаданные партнёров + note/archived */
  const pmeta = db
    .prepare(
      `SELECT id, display_name, telegram, type, source, note,
              COALESCE(archived,0) AS archived, COALESCE(active,1) AS active
       FROM partners`,
    )
    .all() as Array<{
      id: number; display_name: string; telegram: string | null; type: string | null;
      source: string | null; note: string | null; archived: number; active: number;
    }>;
  const metaById = new Map(pmeta.map((p) => [p.id, p]));

  /* статусы выплат за прошлую завершённую неделю */
  const weekStart = lastCompletedWeekStart();
  const statusRows = db
    .prepare(`SELECT partner_id, status FROM payout_status WHERE week_start = ?`)
    .all(weekStart) as Array<{ partner_id: number; status: string }>;
  const statusById = new Map(statusRows.map((s) => [s.partner_id, s.status]));

  /* выручка best-effort: транзакции OM по фанам партнёрских линков за период */
  const revById = new Map<number, number>();
  try {
    const rev = db
      .prepare(
        `SELECT l.partner_id AS pid, COALESCE(SUM(t.amount),0) AS rev
         FROM transactions t
         JOIN link_subscribers ls ON ls.of_fan_id = t.fan_id
         JOIN links l ON l.id = ls.link_id
         WHERE l.partner_id IS NOT NULL
           AND date(t.occurred_at) BETWEEN @from AND @to
         GROUP BY l.partner_id`,
      )
      .all({ from, to }) as Array<{ pid: number; rev: number }>;
    for (const r of rev) revById.set(r.pid, r.rev);
  } catch {
    /* нет таблицы/данных — выручка 0 */
  }

  const partners: PartnerAnalytics[] = [];
  for (const [pid, a] of agg) {
    const meta = metaById.get(pid);
    if (!meta) continue;
    /* тренд: последний непустой день vs предыдущий (по дневным фанам) */
    let trend: number | null = null;
    const daysWithData = report.rows.map((r) => r.date).filter((d) => a.byDay.has(d));
    if (daysWithData.length >= 2) {
      const last = a.byDay.get(daysWithData[daysWithData.length - 1]) ?? 0;
      const prev = a.byDay.get(daysWithData[daysWithData.length - 2]) ?? 0;
      trend = last - prev;
    }
    partners.push({
      partner_id: pid,
      display_name: meta.display_name,
      telegram: meta.telegram,
      type: meta.type,
      source: meta.source,
      note: meta.note,
      archived: !!meta.archived,
      active: !!meta.active,
      clicks: a.clicks,
      fans: a.fans,
      cr: a.clicks > 0 ? a.fans / a.clicks : null,
      revenue: revById.get(pid) ?? 0,
      payout: a.payout,
      trend,
      payout_status: statusById.get(pid) === "done" ? "done" : "pending",
    });
  }
  partners.sort((x, y) => y.payout - x.payout);

  /* источники трафика (по активным = не-архивным партнёрам) */
  const srcMap = new Map<string, { clicks: number; fans: number }>();
  for (const p of partners) {
    if (p.archived) continue;
    const key = p.source || "—";
    const s = srcMap.get(key) ?? { clicks: 0, fans: 0 };
    s.clicks += p.clicks; s.fans += p.fans;
    srcMap.set(key, s);
  }
  const sources = [...srcMap.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.fans - a.fans);

  /* KPI: активные (не-архивные) партнёры с данными; клики/фаны/выплата из активных */
  const active = partners.filter((p) => !p.archived);
  const kpi = {
    partners: active.length,
    clicks: active.reduce((s, p) => s + p.clicks, 0),
    fans: active.reduce((s, p) => s + p.fans, 0),
    revenue: active.reduce((s, p) => s + p.revenue, 0),
    payout: active.reduce((s, p) => s + p.payout, 0),
  };

  return {
    from,
    to,
    tz: TRACKING_TZ,
    week_start: weekStart,
    kpi,
    daily,
    tiers: { free: report.summary.free, paid: report.summary.paid },
    sources,
    partners,
  };
}
