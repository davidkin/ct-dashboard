/**
 * Daily capture — снимает накопительный счётчик кликов по каждой компании
 * в daily_link_clicks на сегодняшний (по TRACKING_TZ) день.
 *
 * Это ЕДИНСТВЕННОЕ, что нельзя восстановить задним числом: OnlyMonster отдаёт
 * клики только текущим счётчиком, без истории. Сабы/пейауты деривируются из
 * реальных дат (om_subscribed_at) на чтении и пересчитываются за любой день.
 *
 * runSync=true (ночной режим): сначала обновляем link_subscribers (свежие
 * реальные даты подписки за сегодня), потом снимаем клики.
 */
import { getDb } from "../db/index";
import { getOMAccountForCreator } from "../config/creators";
import { listTrackingLinks } from "../om/client";
import { syncOMAllCreators } from "../om/sync";
import { todayLocal } from "../lib/tz";

export interface DailyCaptureResult {
  day: string;
  links_captured: number;
  links_unmatched: number;
  om_synced: boolean;
  duration_ms: number;
  errors: string[];
}

export async function captureDailyClicks(
  opts: { runSync?: boolean } = {},
): Promise<DailyCaptureResult> {
  const db = getDb();
  const started = Date.now();
  const day = todayLocal();
  const errors: string[] = [];
  let omSynced = false;

  /* Сначала обновляем реальные даты подписки (чтобы сабы за сегодня попали в БД). */
  if (opts.runSync) {
    try {
      await syncOMAllCreators();
      omSynced = true;
    } catch (err) {
      errors.push(`om-sync: ${msg(err)}`);
    }
  }

  /* OM link id (== of_tracking_link_id) → наш internal links.id */
  const linkMap = new Map<string, number>();
  for (const row of db
    .prepare(`SELECT id, of_tracking_link_id FROM links WHERE of_tracking_link_id IS NOT NULL`)
    .all() as Array<{ id: number; of_tracking_link_id: number }>) {
    linkMap.set(String(row.of_tracking_link_id), row.id);
  }

  const creators = (
    db.prepare(`SELECT DISTINCT creator FROM links ORDER BY creator`).all() as Array<{ creator: string }>
  ).map((r) => r.creator);

  const upsert = db.prepare(`
    INSERT INTO daily_link_clicks (link_id, day, clicks_cumulative, captured_at)
    VALUES (@link_id, @day, @clicks, datetime('now'))
    ON CONFLICT(link_id, day) DO UPDATE SET
      clicks_cumulative = excluded.clicks_cumulative,
      captured_at       = datetime('now')
  `);

  let captured = 0;
  let unmatched = 0;
  const seenAccounts = new Set<string>();

  for (const creator of creators) {
    const omAccount = getOMAccountForCreator(creator);
    if (!omAccount || seenAccounts.has(omAccount)) continue;
    seenAccounts.add(omAccount);
    try {
      const links = await listTrackingLinks(omAccount);
      const tx = db.transaction(() => {
        for (const l of links) {
          const internalId = linkMap.get(String(l.id));
          if (!internalId) {
            unmatched++;
            continue;
          }
          upsert.run({ link_id: internalId, day, clicks: l.clicks ?? 0 });
          captured++;
        }
      });
      tx();
    } catch (err) {
      errors.push(`${creator}: ${msg(err)}`);
    }
  }

  return {
    day,
    links_captured: captured,
    links_unmatched: unmatched,
    om_synced: omSynced,
    duration_ms: Date.now() - started,
    errors,
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
