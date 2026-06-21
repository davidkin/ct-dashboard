import { getDb } from "../db/index";
import { getAccountIdForCreator } from "../config/creators";
import { listAllTrackingLinks, OFTrackingLink } from "./client";

export interface SyncResult {
  creator: string;
  accountId: string;
  fetched: number;
  matched: number;
  unmatchedSamples: string[];
  durationMs: number;
}

/**
 * Подтянуть метрики из OnlyFansAPI и обновить таблицу `links`.
 * Матчим по `campaignUrl` ↔ `of_url`.
 * Если ссылка из OF не найдена в Glossary — пропускаем (логируем первые 5).
 */
export async function syncCreator(creator: string): Promise<SyncResult> {
  const accountId = getAccountIdForCreator(creator);
  if (!accountId) {
    throw new Error(`No account configured for creator "${creator}"`);
  }

  const startedAt = Date.now();
  const db = getDb();
  const logId = (
    db
      .prepare(
        `INSERT INTO sync_log (source, status) VALUES (?, 'running') RETURNING id`,
      )
      .get(`of:${creator}`) as { id: number }
  ).id;

  try {
    const links = await listAllTrackingLinks(accountId);
    const fetched = links.length;

    const updateLink = db.prepare(`
      UPDATE links SET
        of_account_id            = @account_id,
        of_tracking_link_id      = @tracking_link_id,
        of_created_at            = @of_created_at,
        clicks_count             = @clicks,
        subscribers_count        = @subs,
        spenders_count           = @spenders,
        revenue_total            = @revenue,
        revenue_per_click        = @rpc,
        revenue_per_subscriber   = @rps,
        last_synced_at           = datetime('now'),
        updated_at               = datetime('now')
      WHERE of_url = @url
    `);
    const insertSnapshot = db.prepare(`
      INSERT INTO snapshots (link_id, clicks_count, subscribers_count, spenders_count, revenue_total)
      SELECT id, @clicks, @subs, @spenders, @revenue FROM links WHERE of_url = @url
    `);
    const findLink = db.prepare(`SELECT id FROM links WHERE of_url = ?`);

    let matched = 0;
    const unmatched: string[] = [];

    const tx = db.transaction((batch: OFTrackingLink[]) => {
      for (const l of batch) {
        const exists = findLink.get(l.campaignUrl) as { id: number } | undefined;
        if (!exists) {
          if (unmatched.length < 10) unmatched.push(l.campaignUrl);
          continue;
        }
        const params = {
          account_id: accountId,
          tracking_link_id: l.id,
          of_created_at: l.createdAt ?? null,
          clicks: l.clicksCount,
          subs: l.subscribersCount,
          spenders: l.revenue.spendersCount,
          revenue: l.revenue.total,
          rpc: l.revenue.revenuePerClick,
          rps: l.revenue.revenuePerSubscriber,
          url: l.campaignUrl,
        };
        updateLink.run(params);
        insertSnapshot.run(params);
        matched++;
      }
    });
    tx(links);

    const durationMs = Date.now() - startedAt;
    db.prepare(
      `UPDATE sync_log SET finished_at = datetime('now'), status = 'ok', items_processed = ? WHERE id = ?`,
    ).run(matched, logId);

    return {
      creator,
      accountId,
      fetched,
      matched,
      unmatchedSamples: unmatched,
      durationMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE sync_log SET finished_at = datetime('now'), status = 'error', error = ? WHERE id = ?`,
    ).run(msg, logId);
    throw err;
  }
}

/**
 * Синкаем все модели у которых сконфигурирован account_id.
 */
export async function syncAllCreators(): Promise<SyncResult[]> {
  const db = getDb();
  const creators = (
    db.prepare(`SELECT DISTINCT creator FROM links ORDER BY creator`).all() as Array<{ creator: string }>
  ).map((r) => r.creator);
  const results: SyncResult[] = [];
  for (const c of creators) {
    if (!getAccountIdForCreator(c)) {
      console.log(`Skip "${c}" — account not configured`);
      continue;
    }
    try {
      results.push(await syncCreator(c));
    } catch (err) {
      console.error(`Sync failed for "${c}":`, err);
    }
  }
  return results;
}
