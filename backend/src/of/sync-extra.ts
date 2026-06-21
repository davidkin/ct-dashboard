/**
 * Синки «второго уровня» — chargebacks, transactions, payouts.
 * Запускаются после основного tracking-links sync, отдельным проходом.
 */
import { getDb } from "../db/index";
import { getAccountIdForCreator } from "../config/creators";
import {
  listChargebacks,
  listPayouts,
  listTransactions,
  OFChargeback,
  OFPayout,
  OFTransaction,
} from "./client";

export interface ExtraSyncResult {
  account_id: string;
  chargebacks: number;
  transactions: number;
  payouts: number;
  duration_ms: number;
  errors: string[];
}

export async function syncExtraForAccount(accountId: string): Promise<ExtraSyncResult> {
  const startedAt = Date.now();
  const db = getDb();
  const errors: string[] = [];
  let cb = 0;
  let tx = 0;
  let po = 0;

  /* === CHARGEBACKS === */
  try {
    const items = await listChargebacks(accountId);
    const stmt = db.prepare(`
      INSERT INTO chargebacks
        (of_account_id, of_id, fan_id, fan_username, amount, currency, reason, status,
         occurred_at, resolved_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(of_account_id, of_id) DO UPDATE SET
        status      = excluded.status,
        resolved_at = excluded.resolved_at,
        raw_json    = excluded.raw_json,
        fetched_at  = datetime('now')
    `);
    const txMode = db.transaction((rows: OFChargeback[]) => {
      for (const r of rows) {
        stmt.run(
          accountId,
          asStr(r.id),
          asStr(r.fan_id),
          r.fan_username ?? null,
          numOrNull(r.amount),
          r.currency ?? null,
          r.reason ?? null,
          r.status ?? null,
          asStr(r.created_at),
          asStr(r.resolved_at),
          JSON.stringify(r),
        );
      }
    });
    txMode(items);
    cb = items.length;
  } catch (err) {
    errors.push(`chargebacks: ${msg(err)}`);
  }

  /* === TRANSACTIONS === */
  try {
    const items = await listTransactions(accountId, 30);
    const stmt = db.prepare(`
      INSERT INTO transactions
        (of_account_id, of_id, fan_id, fan_username, amount, net, currency, type, description,
         occurred_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(of_account_id, of_id) DO UPDATE SET
        amount      = excluded.amount,
        net         = excluded.net,
        type        = excluded.type,
        description = excluded.description,
        raw_json    = excluded.raw_json,
        fetched_at  = datetime('now')
    `);
    const txMode = db.transaction((rows: OFTransaction[]) => {
      for (const r of rows) {
        stmt.run(
          accountId,
          asStr(r.id),
          asStr(r.fan_id),
          r.fan_username ?? null,
          numOrNull(r.amount),
          numOrNull(r.net),
          r.currency ?? null,
          r.type ?? null,
          r.description ?? null,
          asStr(r.created_at),
          JSON.stringify(r),
        );
      }
    });
    txMode(items);
    tx = items.length;
  } catch (err) {
    errors.push(`transactions: ${msg(err)}`);
  }

  /* === PAYOUTS === */
  try {
    const items = await listPayouts(accountId);
    const stmt = db.prepare(`
      INSERT INTO payouts
        (of_account_id, of_id, amount, net, currency, status, requested_at, paid_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(of_account_id, of_id) DO UPDATE SET
        status     = excluded.status,
        paid_at    = excluded.paid_at,
        raw_json   = excluded.raw_json,
        fetched_at = datetime('now')
    `);
    const txMode = db.transaction((rows: OFPayout[]) => {
      for (const r of rows) {
        stmt.run(
          accountId,
          asStr(r.id),
          numOrNull(r.amount),
          numOrNull(r.net),
          r.currency ?? null,
          r.status ?? null,
          asStr(r.created_at),
          asStr(r.paid_at),
          JSON.stringify(r),
        );
      }
    });
    txMode(items);
    po = items.length;
  } catch (err) {
    errors.push(`payouts: ${msg(err)}`);
  }

  return {
    account_id: accountId,
    chargebacks: cb,
    transactions: tx,
    payouts: po,
    duration_ms: Date.now() - startedAt,
    errors,
  };
}

export async function syncExtraForAllCreators(): Promise<ExtraSyncResult[]> {
  const db = getDb();
  const creators = (
    db.prepare(`SELECT DISTINCT creator FROM links ORDER BY creator`).all() as Array<{ creator: string }>
  ).map((r) => r.creator);
  const seen = new Set<string>();
  const out: ExtraSyncResult[] = [];
  for (const c of creators) {
    const acct = getAccountIdForCreator(c);
    if (!acct || seen.has(acct)) continue;
    seen.add(acct);
    try {
      out.push(await syncExtraForAccount(acct));
    } catch (err) {
      console.error(`Extra sync failed for ${acct}:`, err);
    }
  }
  return out;
}

function asStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
