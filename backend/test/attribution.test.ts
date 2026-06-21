import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { runMigrations } from "../src/db/migrations";
import { getModelGroup } from "../src/config/creators";
import { resolveIdentity } from "../src/fans/identity";
import { recordFanEvent, recordRevenueEvent } from "../src/fans/ledger";
import { recomputeAll, overview, partners, fanTimeline } from "../src/fans/attribution";
import { partnerPayouts, linkPayouts } from "../src/fans/payout";

/* ------------------------------ test harness ------------------------------ */

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const schema = fs.readFileSync(path.resolve(__dirname, "../src/db/schema.sql"), "utf-8");
  db.exec(schema);
  runMigrations(db);
  return db;
}

function seedPartner(db: Database.Database, name: string): number {
  const r = db
    .prepare(`INSERT INTO partners (glossary_name, display_name) VALUES (?, ?)`)
    .run(name, name);
  return Number(r.lastInsertRowid);
}

interface LinkOpts {
  partnerId: number;
  creator: string;
  ofUrl: string;
  cpfFree?: number | null;
  cpfPaid?: number | null;
  revshare?: number | null;
}
function seedLink(db: Database.Database, o: LinkOpts): number {
  const acct = o.creator.toLowerCase().includes("vip") ? "acct_vip" : "acct_free";
  const r = db
    .prepare(
      `INSERT INTO links (partner_id, creator, campaign_code, of_url, cpf_free, cpf_paid, revshare_pct, of_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(o.partnerId, o.creator, o.ofUrl, o.ofUrl, o.cpfFree ?? null, o.cpfPaid ?? null, o.revshare ?? null, acct);
  return Number(r.lastInsertRowid);
}

function ingestSub(
  db: Database.Database,
  linkId: number,
  ofFanId: string,
  username: string,
  at: string,
): void {
  const link = db
    .prepare(`SELECT of_account_id, creator, partner_id FROM links WHERE id = ?`)
    .get(linkId) as { of_account_id: string; creator: string; partner_id: number };
  const modelGroup = getModelGroup(link.creator);
  const r = resolveIdentity(db, {
    ofFanId,
    username,
    ofAccountId: link.of_account_id,
    creator: link.creator,
    modelGroup,
    sourceEndpoint: "test",
    sourceEventAt: at,
  });
  recordFanEvent(db, {
    fanId: r.fanId,
    identityId: r.identityId,
    eventType: "subscriber_seen",
    ofAccountId: link.of_account_id,
    creator: link.creator,
    modelGroup,
    linkId,
    partnerId: link.partner_id,
    source: "test",
    observedAt: at,
    sourceEventAt: at,
    dedupeKey: `sub:${linkId}:${ofFanId}`,
  });
}

// Как ingestSub, но БЕЗ source_event_at (имитация cache-backfill: реального времени нет).
function ingestSubCache(
  db: Database.Database,
  linkId: number,
  ofFanId: string,
  username: string,
  observedAt: string,
): void {
  const link = db
    .prepare(`SELECT of_account_id, creator, partner_id FROM links WHERE id = ?`)
    .get(linkId) as { of_account_id: string; creator: string; partner_id: number };
  const modelGroup = getModelGroup(link.creator);
  const r = resolveIdentity(db, {
    ofFanId,
    username,
    ofAccountId: link.of_account_id,
    creator: link.creator,
    modelGroup,
    sourceEndpoint: "test-cache",
    sourceEventAt: null,
  });
  recordFanEvent(db, {
    fanId: r.fanId,
    identityId: r.identityId,
    eventType: "subscriber_seen",
    ofAccountId: link.of_account_id,
    creator: link.creator,
    modelGroup,
    linkId,
    partnerId: link.partner_id,
    source: "tracking_link_sync",
    observedAt,
    sourceEventAt: null,
    dedupeKey: `sub:${linkId}:${ofFanId}`,
  });
}

function ingestVipSeen(db: Database.Database, ofFanId: string, username: string, at: string): void {
  const creator = "Nekoletta Vip";
  const modelGroup = getModelGroup(creator);
  const r = resolveIdentity(db, {
    ofFanId,
    username,
    ofAccountId: "acct_vip",
    creator,
    modelGroup,
    sourceEndpoint: "test-vip",
    sourceEventAt: at,
  });
  recordFanEvent(db, {
    fanId: r.fanId,
    identityId: r.identityId,
    eventType: "vip_seen",
    ofAccountId: "acct_vip",
    creator,
    modelGroup,
    linkId: null,
    source: "test",
    observedAt: at,
    sourceEventAt: at,
    dedupeKey: `vip:${ofFanId}`,
  });
}

function addRevenue(
  db: Database.Database,
  ofFanId: string,
  creator: string,
  amount: number,
  txId: string,
  linkId: number | null,
  at: string,
): void {
  const fan = db.prepare(`SELECT id FROM fans WHERE primary_of_fan_id = ?`).get(ofFanId) as
    | { id: number }
    | undefined;
  recordRevenueEvent(db, {
    fanId: fan?.id ?? null,
    ofAccountId: creator.toLowerCase().includes("vip") ? "acct_vip" : "acct_free",
    creator,
    modelGroup: getModelGroup(creator),
    transactionId: txId,
    amount,
    currency: "USD",
    revenueType: "subscription",
    occurredAt: at,
    linkId,
  });
}

const touchesFor = (db: Database.Database, fanOfId: string) =>
  db
    .prepare(
      `SELECT t.link_id, t.touch_role, t.cpf_eligible
       FROM fan_link_touches t JOIN fans f ON f.id = t.fan_id
       WHERE f.primary_of_fan_id = ? ORDER BY t.first_touch_at, t.link_id`,
    )
    .all(fanOfId) as Array<{ link_id: number; touch_role: string; cpf_eligible: number }>;

/* ------------------------------ scenarios ------------------------------ */

test("a) first-touch Free → один CPF-eligible touch", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const la = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5 });
  ingestSub(db, la, "100", "fan100", "2026-01-01 10:00:00");
  recomputeAll(db);

  const t = touchesFor(db, "100");
  assert.equal(t.length, 1);
  assert.equal(t[0].touch_role, "first_touch");
  assert.equal(t[0].cpf_eligible, 1);

  const pay = partnerPayouts(db).get(a)!;
  assert.equal(pay.cpf_eligible_fans, 1);
  assert.equal(pay.cpf_component, 1.5);
  assert.equal(pay.payout_total, 1.5);

  const ov = overview(db);
  assert.equal(ov.total_first_touch_fans, 1);
  assert.equal(ov.overlap_fans, 0);
  assert.equal(ov.free_fans, 1);
});

test("b) repeat link touch (тот же партнёр, 2 ссылки) → CPF один раз", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const la = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5 });
  const lb = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/b", cpfFree: 1.5 });
  ingestSub(db, la, "100", "fan", "2026-01-01 10:00:00");
  ingestSub(db, lb, "100", "fan", "2026-01-01 11:00:00");
  recomputeAll(db);

  const t = touchesFor(db, "100");
  assert.equal(t.length, 2);
  assert.equal(t[0].touch_role, "first_touch");
  assert.equal(t[0].cpf_eligible, 1);
  assert.equal(t[1].touch_role, "repeat_touch");
  assert.equal(t[1].cpf_eligible, 0);

  const pay = partnerPayouts(db).get(a)!;
  assert.equal(pay.cpf_eligible_fans, 1);
  assert.equal(pay.cpf_component, 1.5);
  const ovB = overview(db);
  assert.equal(ovB.multi_touch_fans, 1);
  assert.equal(ovB.overlap_fans, 0); // тот же партнёр → не cross-partner overlap
});

test("c) resubscribe по ДРУГОЙ ссылке другого партнёра → второй CPF не платится", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const b = seedPartner(db, "B");
  const la = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5 });
  const lb = seedLink(db, { partnerId: b, creator: "Nekoletta Free", ofUrl: "u/b", cpfFree: 2.0 });
  ingestSub(db, la, "100", "fan", "2026-01-01 10:00:00");
  ingestSub(db, lb, "100", "fan", "2026-01-05 10:00:00");
  recomputeAll(db);

  const t = touchesFor(db, "100");
  assert.equal(t[0].touch_role, "first_touch"); // link A
  assert.equal(t[1].touch_role, "overlap"); // link B, другой партнёр
  assert.equal(t[1].cpf_eligible, 0);

  const map = partnerPayouts(db);
  assert.equal(map.get(a)!.cpf_component, 1.5);
  assert.equal(map.get(b)!.cpf_component, 0); // партнёр B не получает CPF
  assert.equal(map.get(b)!.cpf_eligible_fans, 0);
  const ovC = overview(db);
  assert.equal(ovC.overlap_fans, 1); // разные партнёры → overlap
  assert.equal(ovC.multi_touch_fans, 1);
});

test("d) Free → VIP organic → conversion в аналитике, revenue НЕ в payout партнёра", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const la = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5 });
  ingestSub(db, la, "100", "fan", "2026-01-01 10:00:00");
  ingestVipSeen(db, "100", "fan", "2026-01-02 10:00:00");
  addRevenue(db, "100", "Nekoletta Vip", 80, "tx-vip-1", null, "2026-01-02 10:05:00");
  recomputeAll(db);

  const ov = overview(db);
  assert.equal(ov.free_to_vip_conversions, 1);
  assert.equal(ov.gross_vip_revenue_from_free_fans, 80);
  assert.equal(ov.free_cpf_cost, 1.5);
  assert.equal(ov.avg_time_to_vip_hours, 24);
  assert.ok(ov.agency_recoup_rate && ov.agency_recoup_rate > 50);

  const pa = partners(db).find((p) => p.partner_id === a)!;
  assert.equal(pa.free_to_vip_conversions, 1);
  assert.equal(pa.gross_vip_revenue_from_free_fans, 80);
  assert.equal(pa.revshare_component, 0); // organic VIP не уходит партнёру
  assert.equal(pa.payout_total, 1.5); // только CPF

  const rev = db
    .prepare(`SELECT attribution_type, attributed_partner_id FROM fan_revenue_events WHERE transaction_id='tx-vip-1'`)
    .get() as { attribution_type: string; attributed_partner_id: number | null };
  assert.equal(rev.attribution_type, "agency_free_to_vip");
  assert.equal(rev.attributed_partner_id, null);
});

test("e) CPF only → revshare_component = 0", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const la = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5 });
  ingestSub(db, la, "100", "fan", "2026-01-01 10:00:00");
  addRevenue(db, "100", "Nekoletta Free", 100, "tx1", la, "2026-01-01 12:00:00");
  recomputeAll(db);

  const lp = linkPayouts(db).find((l) => l.link_id === la)!;
  assert.equal(lp.cpf_component, 1.5);
  assert.equal(lp.revshare_component, 0); // ставки revshare нет
  assert.equal(lp.payout_total, 1.5);
});

test("f) CPF + RevShare из Glossary → компоненты СКЛАДЫВАЮТСЯ (не MAX)", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const la = seedLink(db, {
    partnerId: a,
    creator: "Nekoletta Free",
    ofUrl: "u/a",
    cpfFree: 1.5,
    revshare: 0.3,
  });
  ingestSub(db, la, "100", "fan", "2026-01-01 10:00:00");
  addRevenue(db, "100", "Nekoletta Free", 100, "tx1", la, "2026-01-01 12:00:00");
  recomputeAll(db);

  const lp = linkPayouts(db).find((l) => l.link_id === la)!;
  assert.equal(lp.cpf_component, 1.5);
  assert.equal(lp.revshare_component, 30); // 100 × 0.30
  assert.equal(lp.payout_total, 31.5); // сумма, не MAX(1.5, 30)=30
});

test("g) username изменился, of_fan_id тот же → один фан, история не ломается", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const la = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5 });
  ingestSub(db, la, "100", "alpha", "2026-01-01 10:00:00");
  ingestSub(db, la, "100", "beta", "2026-01-02 10:00:00");
  recomputeAll(db);

  assert.equal((db.prepare(`SELECT COUNT(*) n FROM fans`).get() as { n: number }).n, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM fan_identities`).get() as { n: number }).n, 1);
  const ident = db
    .prepare(`SELECT username FROM fan_identities WHERE of_fan_id='100'`)
    .get() as { username: string };
  assert.equal(ident.username, "beta"); // username обновился
  assert.equal(touchesFor(db, "100").length, 1);
});

test("h) username тот же, of_fan_id разный → НЕ склеиваем, пишем inferred match", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const la = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5 });
  ingestSub(db, la, "100", "same", "2026-01-01 10:00:00");
  ingestSub(db, la, "200", "same", "2026-01-02 10:00:00");
  recomputeAll(db);

  assert.equal((db.prepare(`SELECT COUNT(*) n FROM fans`).get() as { n: number }).n, 2);
  const match = db
    .prepare(`SELECT match_method, is_exact FROM fan_identity_matches`)
    .get() as { match_method: string; is_exact: number } | undefined;
  assert.ok(match, "inferred match должен быть записан");
  assert.equal(match!.match_method, "same_username_same_model_group");
  assert.equal(match!.is_exact, 0);

  // inferred НЕ мерджит → два разных фана, оба first-touch (safe default)
  const lp = linkPayouts(db).find((l) => l.link_id === la)!;
  assert.equal(lp.cpf_eligible_fans, 2);
});

test("i) revenue с чужим link_id → RevShare идёт FIRST-TOUCH партнёру, не владельцу ссылки", () => {
  const db = makeDb();
  const p1 = seedPartner(db, "P1");
  const p2 = seedPartner(db, "P2");
  const la = seedLink(db, { partnerId: p1, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5, revshare: 0.3 });
  const lb = seedLink(db, { partnerId: p2, creator: "Nekoletta Free", ofUrl: "u/b", revshare: 0.5 });
  ingestSub(db, la, "100", "fan", "2026-01-01 10:00:00"); // first-touch = link A (P1)
  addRevenue(db, "100", "Nekoletta Free", 100, "tx1", lb, "2026-01-02 10:00:00"); // revenue помечено link B (P2)
  recomputeAll(db);

  const rev = db
    .prepare(
      `SELECT attributed_partner_id, attribution_type, link_id FROM fan_revenue_events WHERE transaction_id='tx1'`,
    )
    .get() as { attributed_partner_id: number; attribution_type: string; link_id: number };
  assert.equal(rev.attribution_type, "direct_link");
  assert.equal(rev.attributed_partner_id, p1);
  assert.equal(rev.link_id, la); // перепривязано к first-touch ссылке

  const map = partnerPayouts(db);
  assert.equal(map.get(p1)!.revshare_component, 30); // 100 × 0.30 → first-touch партнёру
  assert.equal(map.get(p1)!.payout_total, 31.5); // + CPF 1.5
  assert.equal(map.get(p2)?.revshare_component ?? 0, 0); // владельцу чужой ссылки НИЧЕГО
});

test("j) cache-only overlap без source_event_at → first-touch НЕ оплачивается (ambiguous)", () => {
  const db = makeDb();
  const p1 = seedPartner(db, "P1");
  const p2 = seedPartner(db, "P2");
  const la = seedLink(db, { partnerId: p1, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5 });
  const lb = seedLink(db, { partnerId: p2, creator: "Nekoletta Free", ofUrl: "u/b", cpfFree: 2.0 });
  ingestSubCache(db, la, "100", "fan", "2026-01-01 00:00:00");
  ingestSubCache(db, lb, "100", "fan", "2026-01-01 00:00:00"); // тот же фан, оба без реального времени
  recomputeAll(db);

  const elig = (
    db.prepare(`SELECT COALESCE(SUM(cpf_eligible),0) AS n FROM fan_link_touches`).get() as { n: number }
  ).n;
  assert.equal(elig, 0); // нельзя уверенно платить → 0 eligible
  const ft = db
    .prepare(`SELECT cpf_eligibility_reason FROM fan_link_touches WHERE touch_role='first_touch'`)
    .get() as { cpf_eligibility_reason: string };
  assert.equal(ft.cpf_eligibility_reason, "ambiguous_no_source_time");
  assert.equal(overview(db).total_cpf_component, 0); // никакого CPF

  // sanity: single-link cache фан ОПЛАЧИВАЕТСЯ (неоднозначности нет)
  const p3 = seedPartner(db, "P3");
  const lc = seedLink(db, { partnerId: p3, creator: "Nekoletta Free", ofUrl: "u/c", cpfFree: 1.0 });
  ingestSubCache(db, lc, "300", "solo", "2026-01-01 00:00:00");
  recomputeAll(db);
  assert.equal(partnerPayouts(db).get(p3)!.cpf_component, 1.0);
});

test("k) same-partner cache-only multi-link: RevShare платится, CPF withheld (decoupled)", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const la = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5, revshare: 0.3 });
  const lb = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/b", cpfFree: 1.5, revshare: 0.3 });
  // тот же фан на двух ссылках ОДНОГО партнёра, без реального времени (cache)
  ingestSubCache(db, la, "100", "fan", "2026-01-01 00:00:00");
  ingestSubCache(db, lb, "100", "fan", "2026-01-01 00:00:00");
  addRevenue(db, "100", "Nekoletta Free", 100, "tx1", la, "2026-01-02 00:00:00");
  recomputeAll(db);

  const pay = partnerPayouts(db).get(a)!;
  assert.equal(pay.cpf_component, 0); // CPF withheld — порядок неоднозначен
  assert.equal(pay.revshare_component, 30); // RevShare платится — партнёр однозначен (100 × 0.3)
  assert.equal(pay.payout_total, 30);

  const rev = db
    .prepare(`SELECT attribution_type, attributed_partner_id FROM fan_revenue_events WHERE transaction_id='tx1'`)
    .get() as { attribution_type: string; attributed_partner_id: number };
  assert.equal(rev.attribution_type, "direct_link");
  assert.equal(rev.attributed_partner_id, a);
});

test("l) live re-ingest обогащает cache-событие (source_event_at) → ambiguous становится payable", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const la = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5 });
  const lb = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/b", cpfFree: 1.5 });
  ingestSubCache(db, la, "100", "fan", "2026-01-01 00:00:00");
  ingestSubCache(db, lb, "100", "fan", "2026-01-01 00:00:00");
  recomputeAll(db);
  assert.equal(partnerPayouts(db).get(a)!.cpf_component, 0); // cache-only → ambiguous

  // live backfill приносит реальные РАЗНЫЕ времена по тем же dedupeKey
  ingestSub(db, la, "100", "fan", "2026-02-01 10:00:00");
  ingestSub(db, lb, "100", "fan", "2026-02-05 10:00:00");
  recomputeAll(db);

  const ev = db
    .prepare(`SELECT source_event_at FROM fan_events WHERE dedupe_key = ?`)
    .get(`sub:${la}:100`) as { source_event_at: string | null };
  assert.equal(ev.source_event_at, "2026-02-01 10:00:00"); // событие обогатилось

  const pay = partnerPayouts(db).get(a)!;
  assert.equal(pay.cpf_eligible_fans, 1); // теперь порядок достоверен → один CPF
  assert.equal(pay.cpf_component, 1.5);
});

test("m) mixed-clock: реальное время выигрывает first-touch у cache-события с ранним observed_at", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const b = seedPartner(db, "B");
  const la = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5 });
  const lb = seedLink(db, { partnerId: b, creator: "Nekoletta Free", ofUrl: "u/b", cpfFree: 1.5 });
  ingestSubCache(db, la, "100", "fan", "2026-01-01 00:00:00"); // cache, ранний observed, нет source
  ingestSub(db, lb, "100", "fan", "2026-02-01 00:00:00"); // live, реальное время
  recomputeAll(db);

  const ft = db
    .prepare(
      `SELECT link_id FROM fan_link_touches t JOIN fans f ON f.id = t.fan_id
       WHERE f.primary_of_fan_id = '100' AND t.touch_role = 'first_touch'`,
    )
    .get() as { link_id: number };
  assert.equal(ft.link_id, lb); // first_touch = реально-таймстампленный link B, не cache A
});

test("n) migration 002 идемпотентна: повторный прогон при существующей колонке не падает", () => {
  const db = makeDb(); // 001+002 уже применены
  db.prepare("DELETE FROM _migrations WHERE id = '002_touch_cpf_eligibility_reason'").run(); // дрейф
  assert.doesNotThrow(() => runMigrations(db)); // не должно падать 'duplicate column'
  const row = db.prepare("SELECT id FROM _migrations WHERE id = '002_touch_cpf_eligibility_reason'").get();
  assert.ok(row); // запись восстановлена
});

test("o) аналитика first-touch берётся из touch_role, не cpf_eligible (ambiguous фан виден)", () => {
  const db = makeDb();
  const a = seedPartner(db, "A");
  const la = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/a", cpfFree: 1.5 });
  const lb = seedLink(db, { partnerId: a, creator: "Nekoletta Free", ofUrl: "u/b", cpfFree: 1.5 });
  ingestSubCache(db, la, "100", "fan", "2026-01-01 00:00:00");
  ingestSubCache(db, lb, "100", "fan", "2026-01-01 00:00:00");
  recomputeAll(db);

  const ov = overview(db);
  assert.equal(ov.total_first_touch_fans, 1); // ambiguous, но first-touch фан существует
  assert.equal(ov.free_fans, 1);
  assert.equal(ov.total_cpf_component, 0); // CPF по-прежнему withheld

  const fanId = (db.prepare("SELECT id FROM fans WHERE primary_of_fan_id='100'").get() as { id: number }).id;
  const tl = fanTimeline(db, fanId)!;
  assert.ok(tl.first_touch, "first_touch не должен быть null у ambiguous фана");
});
