import Database from "better-sqlite3";
import { CreatorType, getCreatorType } from "../config/creators";
import { linkPayouts, partnerPayouts } from "./payout";

/**
 * Attribution engine.
 *
 *  - recomputeTouches: из fan_events строит fan_link_touches (first_touch/repeat/overlap, cpf_eligible).
 *  - attributeRevenue: проставляет attributed_partner_id + attribution_type на fan_revenue_events.
 *  - report-функции: overview / partners / link / fan timeline.
 *
 * First Touch = самое раннее достоверное появление Global Fan по tracking link.
 * CPF eligible — только first_touch (один фан = один CPF).
 */

const TOUCH_EVENT_TYPES = [
  "subscriber_seen",
  "subscription_new",
  "subscription_renewed",
  "resubscribed_seen",
  "link_touch_seen",
  "active_seen",
];

interface TouchAgg {
  fan_id: number;
  link_id: number;
  partner_id: number | null;
  creator: string | null;
  of_account_id: string | null;
  model_group: string | null;
  source_event_at: string | null;
  observed_at: string | null;
  is_inferred: number;
}

export function recomputeTouches(db: Database.Database): void {
  const placeholders = TOUCH_EVENT_TYPES.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT fe.fan_id, fe.link_id,
              l.partner_id AS partner_id,
              l.creator    AS creator,
              MAX(fe.of_account_id) AS of_account_id,
              MAX(fe.model_group)   AS model_group,
              MIN(fe.source_event_at) AS source_event_at,
              MIN(fe.observed_at)     AS observed_at,
              MAX(fe.is_inferred)     AS is_inferred
       FROM fan_events fe
       JOIN links l ON l.id = fe.link_id
       WHERE fe.fan_id IS NOT NULL AND fe.link_id IS NOT NULL
         AND fe.event_type IN (${placeholders})
       GROUP BY fe.fan_id, fe.link_id`,
    )
    .all(...TOUCH_EVENT_TYPES) as TouchAgg[];

  const byFan = new Map<number, TouchAgg[]>();
  for (const r of rows) {
    const arr = byFan.get(r.fan_id) ?? [];
    arr.push(r);
    byFan.set(r.fan_id, arr);
  }

  const tx = db.transaction(() => {
    db.exec("DELETE FROM fan_link_touches");
    const insert = db.prepare(
      `INSERT INTO fan_link_touches
         (fan_id, link_id, partner_id, creator, of_account_id, model_group,
          touch_role, cpf_eligible, first_touch_at, source_event_at, observed_at,
          match_confidence, cpf_eligibility_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [fanId, touches] of byFan) {
      // Порядок first-touch — по РЕАЛЬНОМУ времени (source_event_at, null = позже), затем
      // observed_at, затем link_id: touch с реальным временем не должен проигрывать cache-событию
      // с ранним observed_at. effectiveTs оставляем только для display (first_touch_at).
      touches.sort(
        (a, b) =>
          tsCompare(a.source_event_at, b.source_event_at) ||
          tsCompare(a.observed_at, b.observed_at) ||
          a.link_id - b.link_id,
      );
      const firstPartner = touches[0].partner_id;
      const firstAt = effectiveTs(touches[0]);
      // CPF-контракт: уверенно платим за first-touch ТОЛЬКО если порядок достоверен.
      // single-link — неоднозначности нет; multi-link — нужен надёжный source_event_at.
      // NB: на текущих cache-данных source_event_at = null, поэтому ветка reliable_first_touch
      // достижима только с live-таймстампами (webhooks/backfill, Phase 2).
      const reliable = isReliableFirstTouch(touches);
      touches.forEach((t, i) => {
        let role: string;
        if (i === 0) role = "first_touch";
        else if (t.partner_id != null && t.partner_id === firstPartner) role = "repeat_touch";
        else role = "overlap";

        let cpfEligible = 0;
        let reason: string;
        if (i !== 0) {
          reason = role;
        } else if (touches.length === 1) {
          cpfEligible = 1;
          reason = "single_link";
        } else if (reliable) {
          cpfEligible = 1;
          reason = "reliable_first_touch";
        } else {
          reason = "ambiguous_no_source_time";
        }
        const confidence =
          i === 0 && cpfEligible === 0 && touches.length > 1 ? 0.3 : t.is_inferred ? 0.5 : 1;

        insert.run(
          fanId,
          t.link_id,
          t.partner_id,
          t.creator,
          t.of_account_id,
          t.model_group,
          role,
          cpfEligible,
          firstAt,
          t.source_event_at,
          t.observed_at,
          confidence,
          reason,
        );
      });
    }
  });
  tx();
}

export function attributeRevenue(db: Database.Database): void {
  const events = db
    .prepare(`SELECT id, fan_id, creator, link_id FROM fan_revenue_events`)
    .all() as Array<{ id: number; fan_id: number | null; creator: string | null; link_id: number | null }>;
  // RevShare-атрибуция НЕ зависит от CPF-порядка: берём first-touch ССЫЛКУ (по роли),
  // а не cpf_eligible-строку. Иначе у ambiguous-фана (cache multi-link) revshare занулялся бы.
  const ftStmt = db.prepare(
    `SELECT link_id, partner_id, creator, cpf_eligible FROM fan_link_touches
     WHERE fan_id = ? AND touch_role = 'first_touch' LIMIT 1`,
  );
  const partnerCountStmt = db.prepare(
    `SELECT COUNT(DISTINCT partner_id) AS n FROM fan_link_touches
     WHERE fan_id = ? AND partner_id IS NOT NULL`,
  );
  const upd = db.prepare(
    `UPDATE fan_revenue_events SET attributed_partner_id = ?, attribution_type = ?, link_id = ? WHERE id = ?`,
  );

  const tx = db.transaction(() => {
    for (const ev of events) {
      let partnerId: number | null = null;
      let attrType = "unknown";
      // link_id на revenue = ССЫЛКА, которой начисляется RevShare (= first-touch ссылка),
      // а не «ссылка транзакции». Иначе payout группирует revenue по чужой ссылке и платит
      // не тому партнёру. null для agency/unknown — партнёрская ссылка ничего не зарабатывает.
      let linkId: number | null = null;
      if (ev.fan_id != null) {
        const ft = ftStmt.get(ev.fan_id) as
          | { link_id: number; partner_id: number | null; creator: string | null; cpf_eligible: number }
          | undefined;
        if (ft) {
          const distinctPartners = (partnerCountStmt.get(ev.fan_id) as { n: number }).n;
          // Платим revshare, если ПАРТНЁР однозначен (один у фана) ИЛИ first-touch достоверен.
          // CPF отдельно гейтится cpf_eligible в payout — здесь его НЕ переиспользуем.
          const partnerUnambiguous = distinctPartners <= 1 || ft.cpf_eligible === 1;
          if (partnerUnambiguous) {
            const ftType = getCreatorType(ft.creator ?? "");
            const revType = getCreatorType(ev.creator ?? "");
            if (ftType && revType) {
              if (ftType === revType) {
                attrType = "direct_link";
                partnerId = ft.partner_id;
                linkId = ft.link_id;
              } else if (ftType === "free" && revType === "vip") {
                attrType = "agency_free_to_vip";
                partnerId = null;
              }
            }
          }
        }
      }
      upd.run(partnerId, attrType, linkId, ev.id);
    }
  });
  tx();
}

export function recomputeAll(db: Database.Database): void {
  recomputeTouches(db);
  attributeRevenue(db);
}

/* ============================= per-fan facts ============================= */

interface FanFact {
  fanId: number;
  linkCount: number;
  partnerIds: Set<number>;
  firstTouchPartnerId: number | null;
  firstTouchLinkId: number | null;
  firstTouchType: CreatorType | null;
  firstTouchAt: string | null;
  vipFirstAt: string | null;
  vipRevenue: number;
  hasVip: boolean;
}

function buildFanFacts(db: Database.Database): Map<number, FanFact> {
  const facts = new Map<number, FanFact>();
  const ensure = (id: number): FanFact => {
    let f = facts.get(id);
    if (!f) {
      f = {
        fanId: id,
        linkCount: 0,
        partnerIds: new Set(),
        firstTouchPartnerId: null,
        firstTouchLinkId: null,
        firstTouchType: null,
        firstTouchAt: null,
        vipFirstAt: null,
        vipRevenue: 0,
        hasVip: false,
      };
      facts.set(id, f);
    }
    return f;
  };

  const touches = db
    .prepare(
      `SELECT fan_id, link_id, partner_id, creator, touch_role, cpf_eligible, first_touch_at
       FROM fan_link_touches`,
    )
    .all() as Array<{
      fan_id: number;
      link_id: number;
      partner_id: number | null;
      creator: string | null;
      touch_role: string;
      cpf_eligible: number;
      first_touch_at: string | null;
    }>;
  for (const t of touches) {
    const f = ensure(t.fan_id);
    f.linkCount += 1;
    if (t.partner_id != null) f.partnerIds.add(t.partner_id);
    // first-touch ФАКТ берём по роли, НЕ по cpf_eligible: ambiguous-фан (CPF withheld)
    // всё равно имеет first-touch для аналитики (overview/free_fans/free→vip/timeline).
    if (t.touch_role === "first_touch") {
      f.firstTouchPartnerId = t.partner_id;
      f.firstTouchLinkId = t.link_id;
      f.firstTouchType = getCreatorType(t.creator ?? "");
      f.firstTouchAt = t.first_touch_at;
    }
  }

  const events = db
    .prepare(
      `SELECT fan_id, creator, COALESCE(source_event_at, observed_at) AS at
       FROM fan_events WHERE fan_id IS NOT NULL`,
    )
    .all() as Array<{ fan_id: number; creator: string | null; at: string | null }>;
  for (const e of events) {
    if (getCreatorType(e.creator ?? "") !== "vip") continue;
    const f = ensure(e.fan_id);
    f.hasVip = true;
    if (e.at && (f.vipFirstAt === null || tsCompare(e.at, f.vipFirstAt) < 0)) f.vipFirstAt = e.at;
  }

  const rev = db
    .prepare(`SELECT fan_id, creator, amount FROM fan_revenue_events WHERE fan_id IS NOT NULL`)
    .all() as Array<{ fan_id: number; creator: string | null; amount: number | null }>;
  for (const r of rev) {
    if (getCreatorType(r.creator ?? "") !== "vip") continue;
    const f = ensure(r.fan_id);
    f.hasVip = true;
    f.vipRevenue += r.amount ?? 0;
  }

  return facts;
}

/* ============================= reports ============================= */

export interface AttributionOverview {
  total_unique_fans: number;
  total_first_touch_fans: number;
  total_repeat_touch_fans: number;
  multi_touch_fans: number;
  overlap_fans: number;
  overlap_rate: number;
  free_fans: number;
  vip_fans: number;
  free_to_vip_conversions: number;
  free_to_vip_conversion_rate: number;
  avg_time_to_vip_hours: number | null;
  median_time_to_vip_hours: number | null;
  gross_vip_revenue_from_free_fans: number;
  free_cpf_cost: number;
  agency_recoup_rate: number | null;
  total_cpf_component: number;
  total_revshare_component: number;
  total_payout: number;
}

export function overview(db: Database.Database): AttributionOverview {
  const facts = buildFanFacts(db);
  const totalFans = (db.prepare(`SELECT COUNT(*) AS n FROM fans`).get() as { n: number }).n;

  let firstTouchFans = 0;
  let multiTouchFans = 0;
  let overlapFans = 0;
  let freeFans = 0;
  let vipFans = 0;
  let conversions = 0;
  let grossVipRevFromFree = 0;
  const ttvHours: number[] = [];

  for (const f of facts.values()) {
    if (f.firstTouchPartnerId !== null || f.firstTouchLinkId !== null) firstTouchFans += 1;
    if (f.linkCount > 1) multiTouchFans += 1; // фан больше чем на одной ссылке
    if (f.partnerIds.size > 1) overlapFans += 1; // overlap = РАЗНЫЕ партнёры (дорогой кейс)
    if (f.firstTouchType === "free") freeFans += 1;
    if (f.hasVip) vipFans += 1;
    if (f.firstTouchType === "free" && f.hasVip) {
      conversions += 1;
      grossVipRevFromFree += f.vipRevenue;
      const dh = hoursBetween(f.firstTouchAt, f.vipFirstAt);
      if (dh !== null) ttvHours.push(dh);
    }
  }

  const links = linkPayouts(db);
  let freeCpfCost = 0;
  let totalCpf = 0;
  let totalRev = 0;
  let totalPayout = 0;
  for (const lp of links) {
    totalCpf += lp.cpf_component;
    totalRev += lp.revshare_component;
    totalPayout += lp.payout_total;
    if (getCreatorType(lp.creator ?? "") === "free") freeCpfCost += lp.cpf_component;
  }

  return {
    total_unique_fans: totalFans,
    total_first_touch_fans: firstTouchFans,
    total_repeat_touch_fans: multiTouchFans,
    multi_touch_fans: multiTouchFans,
    overlap_fans: overlapFans,
    overlap_rate: firstTouchFans ? round4(overlapFans / firstTouchFans) : 0,
    free_fans: freeFans,
    vip_fans: vipFans,
    free_to_vip_conversions: conversions,
    free_to_vip_conversion_rate: freeFans ? round4(conversions / freeFans) : 0,
    avg_time_to_vip_hours: ttvHours.length ? round2(avg(ttvHours)) : null,
    median_time_to_vip_hours: ttvHours.length ? round2(median(ttvHours)) : null,
    gross_vip_revenue_from_free_fans: round2(grossVipRevFromFree),
    free_cpf_cost: round2(freeCpfCost),
    agency_recoup_rate: freeCpfCost > 0 ? round4(grossVipRevFromFree / freeCpfCost) : null,
    total_cpf_component: round2(totalCpf),
    total_revshare_component: round2(totalRev),
    total_payout: round2(totalPayout),
  };
}

export interface PartnerAttribution {
  partner_id: number;
  display_name: string;
  first_touch_fans: number;
  repeat_touch_fans: number;
  overlap_fans: number;
  cpf_eligible_fans: number;
  cpf_component: number;
  revshare_component: number;
  payout_total: number;
  free_to_vip_conversions: number;
  gross_vip_revenue_from_free_fans: number;
  agency_recoup_rate: number | null;
}

export function partners(db: Database.Database): PartnerAttribution[] {
  const facts = buildFanFacts(db);
  const payoutMap = partnerPayouts(db);
  const linkRows = linkPayouts(db);

  // free CPF cost per partner (для recoup)
  const freeCpfByPartner = new Map<number, number>();
  for (const lp of linkRows) {
    if (lp.partner_id == null) continue;
    if (getCreatorType(lp.creator ?? "") === "free") {
      freeCpfByPartner.set(lp.partner_id, (freeCpfByPartner.get(lp.partner_id) ?? 0) + lp.cpf_component);
    }
  }

  // touch-роли по партнёрам
  const roleRows = db
    .prepare(
      `SELECT partner_id,
              SUM(CASE WHEN touch_role='first_touch' THEN 1 ELSE 0 END) AS first_touch,
              SUM(CASE WHEN touch_role IN ('repeat_touch','overlap') THEN 1 ELSE 0 END) AS repeat_touch,
              SUM(CASE WHEN touch_role='overlap' THEN 1 ELSE 0 END) AS overlap,
              SUM(cpf_eligible) AS cpf_eligible
       FROM fan_link_touches WHERE partner_id IS NOT NULL GROUP BY partner_id`,
    )
    .all() as Array<{
      partner_id: number;
      first_touch: number;
      repeat_touch: number;
      overlap: number;
      cpf_eligible: number;
    }>;
  const roleMap = new Map(roleRows.map((r) => [r.partner_id, r]));

  // free→vip по партнёру (партнёр = first-touch partner на free)
  const convByPartner = new Map<number, { conv: number; vipRev: number }>();
  for (const f of facts.values()) {
    if (f.firstTouchType === "free" && f.hasVip && f.firstTouchPartnerId != null) {
      const cur = convByPartner.get(f.firstTouchPartnerId) ?? { conv: 0, vipRev: 0 };
      cur.conv += 1;
      cur.vipRev += f.vipRevenue;
      convByPartner.set(f.firstTouchPartnerId, cur);
    }
  }

  const partnerRows = db
    .prepare(`SELECT id, display_name FROM partners ORDER BY display_name COLLATE NOCASE`)
    .all() as Array<{ id: number; display_name: string }>;

  return partnerRows.map((p) => {
    const role = roleMap.get(p.id);
    const pay = payoutMap.get(p.id);
    const conv = convByPartner.get(p.id);
    const freeCpf = freeCpfByPartner.get(p.id) ?? 0;
    const vipRev = conv?.vipRev ?? 0;
    return {
      partner_id: p.id,
      display_name: p.display_name,
      first_touch_fans: role?.first_touch ?? 0,
      repeat_touch_fans: role?.repeat_touch ?? 0,
      overlap_fans: role?.overlap ?? 0,
      cpf_eligible_fans: role?.cpf_eligible ?? 0,
      cpf_component: pay?.cpf_component ?? 0,
      revshare_component: pay?.revshare_component ?? 0,
      payout_total: pay?.payout_total ?? 0,
      free_to_vip_conversions: conv?.conv ?? 0,
      gross_vip_revenue_from_free_fans: round2(vipRev),
      agency_recoup_rate: freeCpf > 0 ? round4(vipRev / freeCpf) : null,
    };
  });
}

export function linkReport(db: Database.Database, linkId: number): Record<string, unknown> | null {
  const link = db
    .prepare(
      `SELECT id, partner_id, creator, of_url, campaign_code, subscribers_count, spenders_count, revenue_total
       FROM links WHERE id = ?`,
    )
    .get(linkId) as
    | {
        id: number;
        partner_id: number | null;
        creator: string | null;
        of_url: string;
        campaign_code: string;
        subscribers_count: number | null;
        spenders_count: number | null;
        revenue_total: number | null;
      }
    | undefined;
  if (!link) return null;

  const roles = db
    .prepare(
      `SELECT
         COUNT(*) AS unique_fans,
         SUM(CASE WHEN touch_role = 'first_touch' THEN 1 ELSE 0 END) AS first_touch_fans,
         SUM(CASE WHEN touch_role IN ('repeat_touch','overlap') THEN 1 ELSE 0 END) AS repeat_overlap_fans
       FROM fan_link_touches WHERE link_id = ?`,
    )
    .get(linkId) as { unique_fans: number; first_touch_fans: number; repeat_overlap_fans: number };

  // attribution.link_id перепривязан к first-touch ссылке → считаем только direct_link-покупки
  // (revenue, реально начисленный этой ссылке); agency/unknown (link_id=null) сюда не попадают.
  const attributedPurchases = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM fan_revenue_events
         WHERE link_id = ? AND attribution_type = 'direct_link'`,
      )
      .get(linkId) as { n: number }
  ).n;

  const payout = linkPayouts(db).find((lp) => lp.link_id === linkId) ?? null;

  return {
    link_id: link.id,
    campaign_code: link.campaign_code,
    of_url: link.of_url,
    creator: link.creator,
    partner_id: link.partner_id,
    gross_subscribers: link.subscribers_count ?? 0,
    unique_fans: roles.unique_fans ?? 0,
    first_touch_fans: roles.first_touch_fans ?? 0,
    repeat_overlap_fans: roles.repeat_overlap_fans ?? 0,
    spenders: link.spenders_count ?? 0,
    revenue: link.revenue_total ?? 0,
    attributed_purchases: attributedPurchases,
    // Phase 3 (message quality) — пока недоступно из OnlyFansAPI в реалтайме.
    message_read_rate: null,
    reply_rate: null,
    payout_breakdown: payout,
  };
}

export function fanTimeline(db: Database.Database, fanId: number): Record<string, unknown> | null {
  const fan = db.prepare(`SELECT * FROM fans WHERE id = ?`).get(fanId);
  if (!fan) return null;
  const identities = db.prepare(`SELECT * FROM fan_identities WHERE fan_id = ? ORDER BY id`).all(fanId);
  const firstTouch = db
    .prepare(`SELECT * FROM fan_link_touches WHERE fan_id = ? AND touch_role = 'first_touch' LIMIT 1`)
    .get(fanId);
  const touches = db
    .prepare(`SELECT * FROM fan_link_touches WHERE fan_id = ? ORDER BY first_touch_at, link_id`)
    .all(fanId);
  const events = db
    .prepare(
      `SELECT * FROM fan_events WHERE fan_id = ?
       ORDER BY COALESCE(source_event_at, observed_at), id`,
    )
    .all(fanId);
  const revenue = db
    .prepare(`SELECT * FROM fan_revenue_events WHERE fan_id = ? ORDER BY occurred_at`)
    .all(fanId);
  const matches = db.prepare(`SELECT * FROM fan_identity_matches WHERE fan_id = ?`).all(fanId);

  const facts = buildFanFacts(db).get(fanId);

  return {
    fan,
    identities,
    first_touch: firstTouch ?? null,
    touches,
    events,
    revenue,
    identity_matches: matches,
    attribution: facts
      ? {
          link_count: facts.linkCount,
          is_overlap: facts.linkCount > 1,
          first_touch_partner_id: facts.firstTouchPartnerId,
          first_touch_type: facts.firstTouchType,
          first_touch_at: facts.firstTouchAt,
          converted_to_vip: facts.hasVip && facts.firstTouchType === "free",
          time_to_vip_hours:
            facts.firstTouchType === "free" && facts.hasVip
              ? hoursBetween(facts.firstTouchAt, facts.vipFirstAt)
              : null,
          vip_revenue: round2(facts.vipRevenue),
        }
      : null,
  };
}

/* ============================= helpers ============================= */

function effectiveTs(t: TouchAgg): string | null {
  return t.source_event_at ?? t.observed_at ?? null;
}

/**
 * Порядок first-touch достоверен только если у ВСЕХ touch есть реальный source_event_at
 * и самый ранний строго раньше второго (нет ничьей). Иначе CPF за first-touch платить нельзя.
 * (touches уже отсортированы вызывающей стороной.)
 */
function isReliableFirstTouch(touches: TouchAgg[]): boolean {
  if (touches.length <= 1) return true;
  if (touches.some((t) => t.source_event_at == null)) return false;
  return tsCompare(touches[0].source_event_at, touches[1].source_event_at) < 0;
}

function parseTs(s: string | null): number | null {
  if (!s) return null;
  // 'YYYY-MM-DD HH:MM:SS' (SQLite) или ISO с 'T'/таймзоной.
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function tsCompare(a: string | null, b: string | null): number {
  const am = parseTs(a);
  const bm = parseTs(b);
  if (am === null && bm === null) return 0;
  if (am === null) return 1; // null = позже всех
  if (bm === null) return -1;
  return am - bm;
}

function hoursBetween(from: string | null, to: string | null): number | null {
  const a = parseTs(from);
  const b = parseTs(to);
  if (a === null || b === null) return null;
  return round2((b - a) / 3_600_000);
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}
