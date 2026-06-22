import Database from "better-sqlite3";

/**
 * Низкоуровневые писатели в event ledger. Используются backfill/reconciliation
 * (Phase 1) и webhook ingestion (Phase 2).
 *
 * observed_at = когда наш софт увидел событие.
 * source_event_at = реальное время из OnlyFansAPI (если отдаётся), иначе null.
 */
export interface FanEventInput {
  fanId: number | null;
  identityId?: number | null;
  eventType: string;
  ofAccountId?: string | null;
  creator?: string | null;
  modelGroup?: string | null;
  linkId?: number | null;
  partnerId?: number | null;
  source: string;
  observedAt?: string | null;
  sourceEventAt?: string | null;
  isInferred?: boolean;
  dedupeKey?: string | null;
  rawJson?: string | null;
}

/** Идемпотентная запись события. Если dedupeKey уже есть — ничего не дублируем. */
export function recordFanEvent(db: Database.Database, e: FanEventInput): number {
  if (e.dedupeKey) {
    const existing = db
      .prepare(`SELECT id FROM fan_events WHERE dedupe_key = ?`)
      .get(e.dedupeKey) as { id: number } | undefined;
    if (existing) {
      // Обогащаем существующее событие: live backfill может принести реальный source_event_at
      // там, где cache-ingest записал null. Заполняем пропуски, не затирая хорошие данные.
      db.prepare(
        `UPDATE fan_events SET
           source_event_at = COALESCE(source_event_at, ?),
           is_inferred = CASE WHEN source_event_at IS NULL AND ? IS NOT NULL THEN 0 ELSE is_inferred END,
           identity_id = COALESCE(identity_id, ?),
           partner_id = COALESCE(partner_id, ?),
           creator = COALESCE(creator, ?),
           model_group = COALESCE(model_group, ?),
           raw_json = COALESCE(?, raw_json)
         WHERE id = ?`,
      ).run(
        e.sourceEventAt ?? null,
        e.sourceEventAt ?? null,
        e.identityId ?? null,
        e.partnerId ?? null,
        e.creator ?? null,
        e.modelGroup ?? null,
        e.rawJson ?? null,
        existing.id,
      );
      return existing.id;
    }
  }
  const res = db
    .prepare(
      `INSERT INTO fan_events
         (fan_id, identity_id, event_type, of_account_id, creator, model_group,
          link_id, partner_id, source, observed_at, source_event_at, is_inferred, dedupe_key, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?)`,
    )
    .run(
      e.fanId,
      e.identityId ?? null,
      e.eventType,
      e.ofAccountId ?? null,
      e.creator ?? null,
      e.modelGroup ?? null,
      e.linkId ?? null,
      e.partnerId ?? null,
      e.source,
      e.observedAt ?? null,
      e.sourceEventAt ?? null,
      e.isInferred ? 1 : 0,
      e.dedupeKey ?? null,
      e.rawJson ?? null,
    );
  return Number(res.lastInsertRowid);
}

export interface RevenueEventInput {
  fanId: number | null;
  ofAccountId?: string | null;
  creator?: string | null;
  modelGroup?: string | null;
  transactionId?: string | null;
  amount?: number | null;
  net?: number | null;
  currency?: string | null;
  revenueType?: string | null;
  occurredAt?: string | null;
  linkId?: number | null;
  rawJson?: string | null;
}

/** Идемпотентная запись revenue по (of_account_id, transaction_id). attribution заполняется движком позже. */
export function recordRevenueEvent(db: Database.Database, r: RevenueEventInput): number {
  if (r.transactionId && r.ofAccountId) {
    const existing = db
      .prepare(`SELECT id FROM fan_revenue_events WHERE of_account_id = ? AND transaction_id = ?`)
      .get(r.ofAccountId, r.transactionId) as { id: number } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE fan_revenue_events SET
           fan_id = COALESCE(?, fan_id),
           amount = COALESCE(?, amount),
           net = COALESCE(?, net),
           revenue_type = COALESCE(?, revenue_type),
           occurred_at = COALESCE(?, occurred_at),
           link_id = COALESCE(?, link_id),
           raw_json = COALESCE(?, raw_json),
           creator = COALESCE(?, creator),
           model_group = COALESCE(?, model_group),
           currency = COALESCE(?, currency),
           fetched_at = datetime('now')
         WHERE id = ?`,
      ).run(
        r.fanId,
        r.amount ?? null,
        r.net ?? null,
        r.revenueType ?? null,
        r.occurredAt ?? null,
        r.linkId ?? null,
        r.rawJson ?? null,
        r.creator ?? null,
        r.modelGroup ?? null,
        r.currency ?? null,
        existing.id,
      );
      return existing.id;
    }
  }
  const res = db
    .prepare(
      `INSERT INTO fan_revenue_events
         (fan_id, of_account_id, creator, model_group, transaction_id, amount, net, currency,
          revenue_type, occurred_at, link_id, attribution_type, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?)`,
    )
    .run(
      r.fanId,
      r.ofAccountId ?? null,
      r.creator ?? null,
      r.modelGroup ?? null,
      r.transactionId ?? null,
      r.amount ?? null,
      r.net ?? null,
      r.currency ?? null,
      r.revenueType ?? null,
      r.occurredAt ?? null,
      r.linkId ?? null,
      r.rawJson ?? null,
    );
  return Number(res.lastInsertRowid);
}

export interface ApiUsageInput {
  source: string;
  endpoint?: string | null;
  ofAccountId?: string | null;
  creditsUsed?: number | null;
  requestsCount?: number;
  itemsProcessed?: number;
  startedAt?: string | null;
  status?: string | null;
  error?: string | null;
}

export function logApiUsage(db: Database.Database, u: ApiUsageInput): number {
  const res = db
    .prepare(
      `INSERT INTO api_usage_log
         (source, endpoint, of_account_id, credits_used, requests_count, items_processed,
          started_at, finished_at, status, error)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'), ?, ?)`,
    )
    .run(
      u.source,
      u.endpoint ?? null,
      u.ofAccountId ?? null,
      u.creditsUsed ?? null,
      u.requestsCount ?? 0,
      u.itemsProcessed ?? 0,
      u.startedAt ?? null,
      u.status ?? "ok",
      u.error ?? null,
    );
  return Number(res.lastInsertRowid);
}
