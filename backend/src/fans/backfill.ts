import Database from "better-sqlite3";
import { getModelGroup } from "../config/creators";
import { resolveIdentity } from "./identity";
import { logApiUsage, recordFanEvent, recordRevenueEvent } from "./ledger";
import { recomputeAll } from "./attribution";

/**
 * Reconciliation/backfill из УЖЕ имеющихся в БД данных (link_subscribers / link_spenders).
 * Не ходит в OnlyFansAPI → не тратит кредиты. Это дефолт для POST /api/sync/fans.
 *
 * Живой backfill из OF (historical subscribers/transactions) — отдельный шаг,
 * запускается осознанно после подтверждения payload и оценки кредитов (Phase 2).
 *
 * Важно: link_subscribers.subscribed_at = дата ИСТЕЧЕНИЯ (баг текущего синка), поэтому
 * source_event_at не заполняем — реальное время подписки тут недоступно.
 */
export interface ReconcileResult {
  subscribers_ingested: number;
  spenders_ingested: number;
  fans_total: number;
  identities_total: number;
  touches_total: number;
  first_touch_total: number;
  overlap_touch_total: number;
  revenue_events_total: number;
  duration_ms: number;
}

interface SubRow {
  link_id: number;
  of_fan_id: string;
  username: string | null;
  fetched_at: string;
  of_account_id: string | null;
  creator: string | null;
  partner_id: number | null;
}

interface SpenderRow {
  link_id: number;
  of_fan_id: string;
  username: string | null;
  revenue_total: number;
  calculated_at: string | null;
  of_account_id: string | null;
  creator: string | null;
  partner_id: number | null;
}

export function reconcileFromCache(db: Database.Database): ReconcileResult {
  const started = Date.now();

  const subs = db
    .prepare(
      `SELECT ls.link_id, ls.of_fan_id, ls.username, ls.fetched_at,
              l.of_account_id, l.creator, l.partner_id
       FROM link_subscribers ls JOIN links l ON l.id = ls.link_id`,
    )
    .all() as SubRow[];

  let subscribersIngested = 0;
  db.transaction(() => {
    for (const s of subs) {
      const modelGroup = getModelGroup(s.creator);
      const r = resolveIdentity(db, {
        ofFanId: s.of_fan_id,
        username: s.username,
        ofAccountId: s.of_account_id,
        creator: s.creator,
        modelGroup,
        sourceEndpoint: "tracking-links/subscribers",
        sourceEventAt: null,
      });
      recordFanEvent(db, {
        fanId: r.fanId,
        identityId: r.identityId,
        eventType: "subscriber_seen",
        ofAccountId: s.of_account_id,
        creator: s.creator,
        modelGroup,
        linkId: s.link_id,
        partnerId: s.partner_id,
        source: "tracking_link_sync",
        observedAt: s.fetched_at,
        sourceEventAt: null,
        isInferred: false,
        dedupeKey: `sub:${s.link_id}:${s.of_fan_id}`,
      });
      subscribersIngested += 1;
    }
  })();

  const spenders = db
    .prepare(
      `SELECT lsp.link_id, lsp.of_fan_id, lsp.username, lsp.revenue_total, lsp.calculated_at,
              l.of_account_id, l.creator, l.partner_id
       FROM link_spenders lsp JOIN links l ON l.id = lsp.link_id`,
    )
    .all() as SpenderRow[];

  let spendersIngested = 0;
  db.transaction(() => {
    for (const s of spenders) {
      const modelGroup = getModelGroup(s.creator);
      const r = resolveIdentity(db, {
        ofFanId: s.of_fan_id,
        username: s.username,
        ofAccountId: s.of_account_id,
        creator: s.creator,
        modelGroup,
        sourceEndpoint: "tracking-links/spenders",
        sourceEventAt: null,
      });
      recordRevenueEvent(db, {
        fanId: r.fanId,
        ofAccountId: s.of_account_id,
        creator: s.creator,
        modelGroup,
        transactionId: `spender:${s.link_id}:${s.of_fan_id}`,
        amount: s.revenue_total,
        currency: "USD",
        revenueType: "aggregate",
        occurredAt: s.calculated_at,
        linkId: s.link_id,
      });
      spendersIngested += 1;
    }
  })();

  recomputeAll(db);

  const fansTotal = (db.prepare(`SELECT COUNT(*) AS n FROM fans`).get() as { n: number }).n;
  const identitiesTotal = (db.prepare(`SELECT COUNT(*) AS n FROM fan_identities`).get() as { n: number }).n;
  const touchesTotal = (db.prepare(`SELECT COUNT(*) AS n FROM fan_link_touches`).get() as { n: number }).n;
  const firstTouchTotal = (
    db.prepare(`SELECT COUNT(*) AS n FROM fan_link_touches WHERE touch_role='first_touch'`).get() as { n: number }
  ).n;
  const overlapTotal = (
    db.prepare(`SELECT COUNT(*) AS n FROM fan_link_touches WHERE touch_role='overlap'`).get() as { n: number }
  ).n;
  const revenueTotal = (db.prepare(`SELECT COUNT(*) AS n FROM fan_revenue_events`).get() as { n: number }).n;

  const result: ReconcileResult = {
    subscribers_ingested: subscribersIngested,
    spenders_ingested: spendersIngested,
    fans_total: fansTotal,
    identities_total: identitiesTotal,
    touches_total: touchesTotal,
    first_touch_total: firstTouchTotal,
    overlap_touch_total: overlapTotal,
    revenue_events_total: revenueTotal,
    duration_ms: Date.now() - started,
  };

  logApiUsage(db, {
    source: "reconcile_fans",
    endpoint: "local-cache",
    requestsCount: 0,
    itemsProcessed: subscribersIngested + spendersIngested,
    status: "ok",
  });

  return result;
}
