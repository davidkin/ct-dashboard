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
import { todayLocal, addDays } from "../lib/tz";

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
  /* Джоб в 13:30 финализирует ПРЕДЫДУЩИЙ день — как ручной ввод в таблицу
     (партнёр в 13:30 вписывает данные за вчера). Поэтому метим снепшот вчерашним днём. */
  const day = addDays(todayLocal(), -1);
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
    INSERT INTO daily_link_clicks (link_id, day, clicks_cumulative, fans_cumulative, captured_at)
    VALUES (@link_id, @day, @clicks, @fans, datetime('now'))
    ON CONFLICT(link_id, day) DO UPDATE SET
      clicks_cumulative = excluded.clicks_cumulative,
      fans_cumulative   = excluded.fans_cumulative,
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
          upsert.run({ link_id: internalId, day, clicks: l.clicks ?? 0, fans: l.subscribers ?? 0 });
          captured++;
        }
      });
      tx();
    } catch (err) {
      errors.push(`${creator}: ${msg(err)}`);
    }
  }

  /* === Заморозка подневного значения за сегодня ===
     Тот же принцип что ручное заполнение таблицы: считаем «за день» = сегодня_накопит
     − вчера_накопит ОДИН раз при записи и кладём в daily_om_stats. Старые дни не трогаем.
     Читается потом напрямую (сумма), без дельт на чтении. */
  const prevCumStmt = db.prepare(
    `SELECT day, clicks_cumulative AS c, fans_cumulative AS f FROM daily_link_clicks
     WHERE link_id = ? AND day < ? ORDER BY day DESC LIMIT 1`,
  );
  const seedLastStmt = db.prepare(`SELECT MAX(day) AS d FROM daily_sheet_stats WHERE link_id = ?`);
  /* накопительный итог сида на его последний день = сумма подневных значений
     (сид хранит дневные дельты, их сумма = кумулятив на конец сида). Служит
     baseline-ом для первого OM-дня после сида, чтобы «за день» посчиталось реально. */
  const seedSumStmt = db.prepare(
    `SELECT COALESCE(SUM(clicks),0) AS c, COALESCE(SUM(fans),0) AS f FROM daily_sheet_stats WHERE link_id = ?`,
  );
  const upsertDaily = db.prepare(`
    INSERT INTO daily_om_stats (link_id, day, clicks, fans, captured_at)
    VALUES (@link_id, @day, @clicks, @fans, datetime('now'))
    ON CONFLICT(link_id, day) DO UPDATE SET
      clicks = excluded.clicks, fans = excluded.fans, captured_at = datetime('now')
  `);
  const todayRows = db
    .prepare(
      `SELECT link_id, clicks_cumulative AS c, fans_cumulative AS f FROM daily_link_clicks WHERE day = ?`,
    )
    .all(day) as Array<{ link_id: number; c: number; f: number | null }>;
  const freeze = db.transaction(() => {
    for (const t of todayRows) {
      const prev = prevCumStmt.get(t.link_id, day) as
        | { day: string; c: number; f: number | null }
        | undefined;
      const seedLast = (seedLastStmt.get(t.link_id) as { d: string | null } | undefined)?.d ?? null;
      let dClicks = 0;
      let dFans = 0;
      /* baseline для «за день»:
         — если есть предыдущий OM-снимок уже в OM-режиме (после конца сида) → дельта к нему (16.07+);
         — иначе, если есть сид → baseline = накопит.итог сида (первый OM-день после сида, напр. 15.07);
         — иначе, если есть предыдущий OM-снимок (партнёр без сида) → дельта к нему;
         — иначе → 0 (совсем нет базы). */
      let base: { c: number; f: number | null } | null = null;
      if (prev && (!seedLast || prev.day > seedLast)) {
        base = { c: prev.c, f: prev.f };
      } else if (seedLast) {
        const ss = seedSumStmt.get(t.link_id) as { c: number; f: number } | undefined;
        if (ss) base = { c: ss.c, f: ss.f };
      } else if (prev) {
        base = { c: prev.c, f: prev.f };
      }
      if (base) {
        dClicks = Math.max(0, t.c - base.c);
        dFans = t.f != null && base.f != null ? Math.max(0, t.f - base.f) : 0;
      }
      upsertDaily.run({ link_id: t.link_id, day, clicks: dClicks, fans: dFans });
    }
  });
  freeze();

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
