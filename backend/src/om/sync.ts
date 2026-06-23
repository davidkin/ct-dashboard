/**
 * OnlyMonster sync — главная ценность: РЕАЛЬНАЯ subscribed_at дата подписки.
 *
 * Поток:
 *   1. tracking-link-users по каждому аккаунту (Free + Vip)
 *   2. matched по link_id == links.of_tracking_link_id → наш internal link_id
 *   3. upsert в link_subscribers с om_subscribed_at = реальная дата
 *      (новых фанов вставляем, существующим проставляем реальную дату)
 *   4. transactions / chargebacks тоже тянем для revenue/refund attribution
 *
 * После sync нужно дёрнуть reconcileFromCache (ledger backfill) — он подхватит
 * om_subscribed_at как source_event_at.
 */
import { getDb } from "../db/index";
import { getOMAccountForCreator } from "../config/creators";
import {
  listChargebacks,
  listTrackingLinkUsers,
  listTransactions,
  OMChargeback,
  OMTransaction,
} from "./client";

export interface OMSyncResult {
  creator: string;
  om_account_id: string;
  tracking_users_fetched: number;
  subscribers_matched: number;
  subscribers_unmatched_links: number;
  transactions_fetched: number;
  chargebacks_fetched: number;
  duration_ms: number;
  errors: string[];
}

export async function syncOMForCreator(creator: string): Promise<OMSyncResult> {
  const omAccount = getOMAccountForCreator(creator);
  if (!omAccount) throw new Error(`No OnlyMonster account configured for "${creator}"`);

  const db = getDb();
  const started = Date.now();
  const errors: string[] = [];
  let trackingUsersFetched = 0;
  let subscribersMatched = 0;
  const unmatchedLinks = new Set<string>();
  let transactionsFetched = 0;
  let chargebacksFetched = 0;

  /* link_id (OF tracking link id) → наш internal links.id */
  const linkMap = new Map<string, number>();
  for (const row of db
    .prepare(`SELECT id, of_tracking_link_id FROM links WHERE of_tracking_link_id IS NOT NULL`)
    .all() as Array<{ id: number; of_tracking_link_id: number }>) {
    linkMap.set(String(row.of_tracking_link_id), row.id);
  }

  /* === 1. TRACKING-LINK-USERS — реальная subscribed_at === */
  try {
    const users = await listTrackingLinkUsers(omAccount);
    trackingUsersFetched = users.length;

    const upsert = db.prepare(`
      INSERT INTO link_subscribers
        (link_id, of_fan_id, username, subscribed_at, is_active, first_seen_at, om_subscribed_at, fetched_at)
      VALUES (@link_id, @fan_id, @username, NULL, 1, @subscribed_at, @subscribed_at, datetime('now'))
      ON CONFLICT(link_id, of_fan_id) DO UPDATE SET
        username         = COALESCE(excluded.username, link_subscribers.username),
        om_subscribed_at = excluded.om_subscribed_at,
        first_seen_at    = MIN(COALESCE(link_subscribers.first_seen_at, excluded.om_subscribed_at), excluded.om_subscribed_at),
        fetched_at       = datetime('now')
    `);

    const tx = db.transaction(() => {
      for (const u of users) {
        const internalLinkId = linkMap.get(u.link_id);
        if (!internalLinkId) {
          unmatchedLinks.add(u.link_id);
          continue;
        }
        upsert.run({
          link_id: internalLinkId,
          fan_id: u.fan.id,
          username: u.fan.username ?? null,
          subscribed_at: u.subscribed_at,
        });
        subscribersMatched++;
      }
    });
    tx();
  } catch (err) {
    errors.push(`tracking-link-users: ${msg(err)}`);
  }

  /* === 2. TRANSACTIONS — revenue с fan.id + timestamp === */
  try {
    const txs = await listTransactions(omAccount);
    transactionsFetched = txs.length;
    upsertTransactions(creator, omAccount, txs);
  } catch (err) {
    errors.push(`transactions: ${msg(err)}`);
  }

  /* === 3. CHARGEBACKS === */
  try {
    const cbs = await listChargebacks(omAccount);
    chargebacksFetched = cbs.length;
    upsertChargebacks(omAccount, cbs);
  } catch (err) {
    errors.push(`chargebacks: ${msg(err)}`);
  }

  return {
    creator,
    om_account_id: omAccount,
    tracking_users_fetched: trackingUsersFetched,
    subscribers_matched: subscribersMatched,
    subscribers_unmatched_links: unmatchedLinks.size,
    transactions_fetched: transactionsFetched,
    chargebacks_fetched: chargebacksFetched,
    duration_ms: Date.now() - started,
    errors,
  };
}

export async function syncOMAllCreators(): Promise<OMSyncResult[]> {
  const db = getDb();
  const creators = (
    db.prepare(`SELECT DISTINCT creator FROM links ORDER BY creator`).all() as Array<{ creator: string }>
  ).map((r) => r.creator);
  const out: OMSyncResult[] = [];
  const seen = new Set<string>();
  for (const c of creators) {
    const acct = getOMAccountForCreator(c);
    if (!acct || seen.has(acct)) continue;
    seen.add(acct);
    try {
      out.push(await syncOMForCreator(c));
    } catch (err) {
      console.error(`OM sync failed for "${c}":`, err);
    }
  }
  return out;
}

function upsertTransactions(creator: string, omAccount: string, txs: OMTransaction[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO om_transactions (om_account_id, creator, of_id, fan_id, amount, type, status, occurred_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(of_id) DO UPDATE SET
      amount = excluded.amount, status = excluded.status, fetched_at = datetime('now')
  `);
  db.transaction(() => {
    for (const t of txs) {
      stmt.run(omAccount, creator, t.id, t.fan?.id ?? null, t.amount ?? 0, t.type ?? null, t.status ?? null, t.timestamp ?? null);
    }
  })();
}

function upsertChargebacks(omAccount: string, cbs: OMChargeback[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO om_chargebacks (om_account_id, of_id, fan_id, amount, type, status, chargeback_at, transaction_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(of_id) DO UPDATE SET
      status = excluded.status, fetched_at = datetime('now')
  `);
  db.transaction(() => {
    for (const c of cbs) {
      stmt.run(omAccount, c.id, c.fan?.id ?? null, c.amount ?? 0, c.type ?? null, c.status ?? null, c.chargeback_timestamp ?? null, c.transaction_timestamp ?? null);
    }
  })();
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
