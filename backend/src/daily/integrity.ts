/**
 * Самопроверка данных: дашборд теперь единственный источник правды, ручных
 * таблиц для сверки больше нет — значит софт должен ловить свои дыры сам.
 *
 * Проверяем три вещи, каждая из которых означает молча потерянный трафик:
 *   1. untracked  — линк есть в OnlyMonster, но у нас его нет (кампанию завели,
 *      а в глоссарий/базу не внесли: клики копятся мимо дашборда);
 *   2. drift      — наш накопительный итог по линку разошёлся с тоталом OM
 *      сильнее допуска (обычно значит пропущенный день съёмки);
 *   3. gap        — за день нет ни одного снимка (съёмка не отработала).
 *
 * OM отдаёт только текущий счётчик, историю восстановить нельзя, поэтому
 * важно узнать о дыре сразу, а не через месяц.
 */
import { getDb } from "../db/index";
import { listTrackingLinks } from "../om/client";
import { getOMAccountForCreator, getModelGroup, listModels, creatorsInModelGroup } from "../config/creators";
import { todayLocal, addDays } from "../lib/tz";

export type IntegrityStatus = "ok" | "warn" | "fail";

export interface UntrackedLink {
  om_id: string;
  name: string | null;
  creator: string;
  model: string | null;
  url: string | null;
  clicks: number;
  fans: number;
  /** Партнёрская кампания (camp_*) — такие обязаны быть в базе. Остальное —
   *  собственные ссылки модели (twitter, reddit, SFS…), их вести не надо. */
  is_campaign: boolean;
}

export interface DriftLink {
  link_id: number;
  campaign_code: string;
  creator: string;
  partner: string | null;
  our_cumulative: number;
  om_cumulative: number;
  diff: number;
  tolerance: number;
  last_snapshot_day: string | null;
}

export interface IntegrityReport {
  checked_at: string;
  status: IntegrityStatus;
  days_checked: number;
  untracked: UntrackedLink[];
  /** несопоставленные линки, на которых уже есть трафик — эти важнее всего */
  untracked_with_traffic: number;
  drift: DriftLink[];
  gaps: string[];
  errors: string[];
  /** аккаунты отключённых моделей, недоступные в OM — сверка по ним не делается */
  skipped: string[];
}

/* Допуск на дрейф: за время между съёмкой и проверкой линк успевает набрать
   реальные клики, это не потеря. Берём максимум из абсолютного минимума и
   среднего дневного трафика линка за последние 7 дней с запасом. */
const MIN_TOLERANCE = 25;
const AVG_DAYS = 7;
const AVG_MULTIPLIER = 3;

/** Дни, за которые проверяем наличие снимков (не считая сегодняшнего). */
const GAP_WINDOW_DAYS = 14;

export async function runIntegrityCheck(): Promise<IntegrityReport> {
  const db = getDb();
  const errors: string[] = [];

  /* --- линки OM по всем аккаунтам (включая скрытые модели) --- */
  const omByTracking = new Map<string, { name: string | null; creator: string; clicks: number; fans: number; url: string | null }>();
  const seenAccounts = new Set<string>();
  /* Отключённая модель (доступ к её OM-аккаунту отозван) — это ожидаемое
     состояние, а не поломка проверки: пишем отдельно и статус не роняем. */
  const skipped: string[] = [];
  const hiddenGroups = new Set(
    listModels(true).filter((m) => m.hidden).map((m) => m.group),
  );
  for (const { group } of listModels(true)) {
    for (const creator of creatorsInModelGroup(group)) {
      const acct = getOMAccountForCreator(creator);
      if (!acct || seenAccounts.has(acct)) continue;
      seenAccounts.add(acct);
      try {
        for (const l of await listTrackingLinks(acct)) {
          omByTracking.set(String(l.id), {
            name: l.name ?? null,
            creator,
            clicks: l.clicks ?? 0,
            fans: l.subscribers ?? 0,
            url: l.url ?? null,
          });
        }
      } catch (err) {
        const msg = `${creator}: ${err instanceof Error ? err.message : String(err)}`;
        if (hiddenGroups.has(group)) skipped.push(msg);
        else errors.push(msg);
      }
    }
  }

  /* --- 1. есть в OM, нет у нас --- */
  const ourTracking = new Set(
    (db
      .prepare(`SELECT of_tracking_link_id FROM links WHERE of_tracking_link_id IS NOT NULL`)
      .all() as Array<{ of_tracking_link_id: number }>).map((r) => String(r.of_tracking_link_id)),
  );
  const untracked: UntrackedLink[] = [];
  for (const [omId, l] of omByTracking) {
    if (ourTracking.has(omId)) continue;
    untracked.push({
      om_id: omId,
      name: l.name,
      creator: l.creator,
      model: getModelGroup(l.creator),
      url: l.url,
      clicks: l.clicks,
      fans: l.fans,
      is_campaign: /^camp_/i.test(l.name ?? ""),
    });
  }
  /* сначала партнёрские кампании (их чинить), потом всё остальное по трафику */
  untracked.sort((a, b) => Number(b.is_campaign) - Number(a.is_campaign) || b.clicks - a.clicks);
  const untrackedWithTraffic = untracked.filter((l) => l.is_campaign && l.clicks > 0).length;

  /* --- 2. расхождение накопительных итогов --- */
  const rows = db
    .prepare(
      `SELECT l.id AS link_id, l.campaign_code, l.creator, l.of_tracking_link_id,
              p.display_name AS partner,
              (SELECT d.clicks_cumulative FROM daily_link_clicks d
                WHERE d.link_id = l.id ORDER BY d.day DESC LIMIT 1) AS our_cum,
              (SELECT d.day FROM daily_link_clicks d
                WHERE d.link_id = l.id ORDER BY d.day DESC LIMIT 1) AS last_day,
              (SELECT COALESCE(AVG(o.clicks),0) FROM daily_om_stats o
                WHERE o.link_id = l.id AND o.day >= @avgFrom) AS avg_daily
         FROM links l LEFT JOIN partners p ON p.id = l.partner_id
        WHERE l.of_tracking_link_id IS NOT NULL`,
    )
    .all({ avgFrom: addDays(todayLocal(), -AVG_DAYS) }) as Array<{
      link_id: number; campaign_code: string; creator: string; of_tracking_link_id: number;
      partner: string | null; our_cum: number | null; last_day: string | null; avg_daily: number;
    }>;

  const drift: DriftLink[] = [];
  for (const r of rows) {
    const om = omByTracking.get(String(r.of_tracking_link_id));
    if (!om) continue; // линк пропал из OM — отдельный случай, не дрейф
    const our = r.our_cum ?? 0;
    const tolerance = Math.max(MIN_TOLERANCE, Math.round(r.avg_daily * AVG_MULTIPLIER));
    const diff = om.clicks - our;
    if (diff > tolerance) {
      drift.push({
        link_id: r.link_id,
        campaign_code: r.campaign_code,
        creator: r.creator,
        partner: r.partner,
        our_cumulative: our,
        om_cumulative: om.clicks,
        diff,
        tolerance,
        last_snapshot_day: r.last_day,
      });
    }
  }
  drift.sort((a, b) => b.diff - a.diff);

  /* --- 3. дни без единого снимка --- */
  const days = new Set(
    (db
      .prepare(`SELECT DISTINCT day FROM daily_link_clicks WHERE day >= ?`)
      .all(addDays(todayLocal(), -GAP_WINDOW_DAYS)) as Array<{ day: string }>).map((r) => r.day),
  );
  const gaps: string[] = [];
  for (let i = 1; i <= GAP_WINDOW_DAYS; i++) {
    const d = addDays(todayLocal(), -i);
    if (!days.has(d)) gaps.push(d);
  }
  gaps.sort();

  const status: IntegrityStatus =
    errors.length || gaps.length || drift.length ? "fail" : untrackedWithTraffic ? "warn" : "ok";

  const report: IntegrityReport = {
    checked_at: new Date().toISOString(),
    status,
    days_checked: GAP_WINDOW_DAYS,
    untracked,
    untracked_with_traffic: untrackedWithTraffic,
    drift,
    gaps,
    errors,
    skipped,
  };

  saveReport(report);
  return report;
}

function saveReport(report: IntegrityReport): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO integrity_checks (checked_at, status, untracked_count, untracked_with_traffic,
                                       drift_count, gap_count, report_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.checked_at,
        report.status,
        report.untracked.length,
        report.untracked_with_traffic,
        report.drift.length,
        report.gaps.length,
        JSON.stringify(report),
      );
  } catch (err) {
    console.error("[integrity] save failed:", err);
  }
}

/** Последняя сохранённая проверка (для UI, без похода в OM). */
export function getLastIntegrityReport(): IntegrityReport | null {
  const row = getDb()
    .prepare(`SELECT report_json FROM integrity_checks ORDER BY id DESC LIMIT 1`)
    .get() as { report_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.report_json) as IntegrityReport;
  } catch {
    return null;
  }
}
