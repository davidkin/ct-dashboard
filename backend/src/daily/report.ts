/**
 * Daily report — строит дневной трекинг как в ручной таблице партнёра.
 *
 * Строки = дни (TRACKING_TZ), колонки = компании. По каждой ячейке:
 *   subs   = COUNT(om_subscribed_at → киевский день = D)   — точно, из реальных дат
 *   clicks = clicks_cumulative[D] − clicks_cumulative[D−1]  — дельта снэпшота
 *   cr     = subs / clicks
 *   payout = subs × cpf
 * Плюс Total-строка за день (горизонтальная сумма компаний) и дельта сабов к
 * предыдущему дню.
 *
 * clicks = null означает «нет baseline» (день раньше первого ночного снэпшота) —
 * клики задним числом восстановить нельзя, сабы — можно за всю историю.
 */
import { getDb } from "../db/index";
import { getCreatorType } from "../config/creators";
import { localDay, dayRange, TRACKING_TZ } from "../lib/tz";

export interface DailyCampaign {
  link_id: number;
  campaign_code: string;
  creator: string;
  cpf: number;
  partner_id: number | null;
  partner_name: string | null;
}

export interface DailyCell {
  clicks: number | null;
  subs: number;
  cr: number | null;
  payout: number;
}

export interface DailyTotal {
  clicks: number | null;
  subs: number;
  cr: number | null;
  payout: number;
  /** изменение дневного объёма сабов к предыдущему дню (тренд), null для первого дня */
  subs_delta: number | null;
}

export interface DailyRow {
  date: string;
  total: DailyTotal;
  cells: Record<string, DailyCell>; // ключ = String(link_id)
}

export interface DailyReport {
  creator: string | null;
  from: string;
  to: string;
  tz: string;
  campaigns: DailyCampaign[];
  rows: DailyRow[];
  /** с какого дня доступна дневная разбивка кликов (первый ночной снэпшот) */
  clicks_available_from: string | null;
}

interface BuildOpts {
  creator: string | null;
  from: string;
  to: string;
  /** фильтр по партнёру (partners.id); null = все партнёры */
  partner?: number | null;
  includeEmpty?: boolean;
}

function pickCpf(creator: string, cpfFree: number | null, cpfPaid: number | null): number {
  const type = getCreatorType(creator);
  if (type === "vip") return cpfPaid ?? cpfFree ?? 0;
  return cpfFree ?? cpfPaid ?? 0;
}

function naturalCmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function buildDailyReport(opts: BuildOpts): DailyReport {
  const db = getDb();
  const { creator, from, to } = opts;
  const partner = opts.partner ?? null;
  const days = dayRange(from, to);

  /* === компании (ссылки) + их CPF + партнёр-владелец === */
  const linkRows = db
    .prepare(
      `SELECT l.id AS link_id, l.campaign_code, l.creator, l.cpf_free, l.cpf_paid,
              l.partner_id, p.display_name AS partner_name
       FROM links l
       LEFT JOIN partners p ON p.id = l.partner_id
       WHERE (@creator IS NULL OR l.creator = @creator)
         AND (@partner IS NULL OR l.partner_id = @partner)`,
    )
    .all({ creator: creator ?? null, partner }) as Array<{
      link_id: number;
      campaign_code: string;
      creator: string;
      cpf_free: number | null;
      cpf_paid: number | null;
      partner_id: number | null;
      partner_name: string | null;
    }>;

  const campaignMap = new Map<number, DailyCampaign>();
  for (const r of linkRows) {
    campaignMap.set(r.link_id, {
      link_id: r.link_id,
      campaign_code: r.campaign_code,
      creator: r.creator,
      cpf: pickCpf(r.creator, r.cpf_free, r.cpf_paid),
      partner_id: r.partner_id,
      partner_name: r.partner_name,
    });
  }

  /* === сабы по (link, day) из реальных дат === */
  const subRows = db
    .prepare(
      `SELECT ls.link_id, ls.om_subscribed_at
       FROM link_subscribers ls JOIN links l ON l.id = ls.link_id
       WHERE ls.om_subscribed_at IS NOT NULL
         AND (@creator IS NULL OR l.creator = @creator)
         AND (@partner IS NULL OR l.partner_id = @partner)`,
    )
    .all({ creator: creator ?? null, partner }) as Array<{ link_id: number; om_subscribed_at: string }>;

  const subsByLinkDay = new Map<number, Map<string, number>>();
  for (const s of subRows) {
    const day = localDay(s.om_subscribed_at);
    if (!day) continue;
    let m = subsByLinkDay.get(s.link_id);
    if (!m) {
      m = new Map();
      subsByLinkDay.set(s.link_id, m);
    }
    m.set(day, (m.get(day) ?? 0) + 1);
  }

  /* === клики: дельты из накопительного счётчика === */
  const clickRows = db
    .prepare(
      `SELECT dc.link_id, dc.day, dc.clicks_cumulative
       FROM daily_link_clicks dc JOIN links l ON l.id = dc.link_id
       WHERE (@creator IS NULL OR l.creator = @creator)
         AND (@partner IS NULL OR l.partner_id = @partner)
       ORDER BY dc.link_id, dc.day`,
    )
    .all({ creator: creator ?? null, partner }) as Array<{
      link_id: number;
      day: string;
      clicks_cumulative: number;
    }>;

  const cumulByLink = new Map<number, Array<{ day: string; cumul: number }>>();
  for (const c of clickRows) {
    let arr = cumulByLink.get(c.link_id);
    if (!arr) {
      arr = [];
      cumulByLink.set(c.link_id, arr);
    }
    arr.push({ day: c.day, cumul: c.clicks_cumulative });
  }

  const deltaByLinkDay = new Map<number, Map<string, number | null>>();
  let earliestCaptureDay: string | null = null;
  for (const [linkId, arr] of cumulByLink) {
    const m = new Map<string, number | null>();
    for (let i = 0; i < arr.length; i++) {
      if (i === 0) {
        m.set(arr[i].day, null); // первый снэпшот — нет baseline
      } else {
        const d = arr[i].cumul - arr[i - 1].cumul;
        m.set(arr[i].day, d >= 0 ? d : null); // сброс счётчика → неизвестно
      }
    }
    deltaByLinkDay.set(linkId, m);
    const first = arr[0]?.day;
    if (first && (!earliestCaptureDay || first < earliestCaptureDay)) earliestCaptureDay = first;
  }

  /* === оверлей: точный снимок из ручной таблицы Traffic Tracking ===
     Импортированные клики+фаны перебивают OM-derived, чтобы цифры совпадали
     с таблицей. Покрывает историю кликов, которую из OM не восстановить. */
  const sheetByLinkDay = new Map<number, Map<string, { clicks: number; fans: number }>>();
  let earliestSheetDay: string | null = null;
  let latestSheetDay: string | null = null;
  for (const s of db
    .prepare(
      `SELECT ds.link_id, ds.day, ds.clicks, ds.fans
       FROM daily_sheet_stats ds JOIN links l ON l.id = ds.link_id
       WHERE (@creator IS NULL OR l.creator = @creator)
         AND (@partner IS NULL OR l.partner_id = @partner)`,
    )
    .all({ creator: creator ?? null, partner }) as Array<{
      link_id: number;
      day: string;
      clicks: number;
      fans: number;
    }>) {
    let m = sheetByLinkDay.get(s.link_id);
    if (!m) { m = new Map(); sheetByLinkDay.set(s.link_id, m); }
    m.set(s.day, { clicks: s.clicks, fans: s.fans });
    if (!earliestSheetDay || s.day < earliestSheetDay) earliestSheetDay = s.day;
    if (!latestSheetDay || s.day > latestSheetDay) latestSheetDay = s.day;
  }
  /* День внутри диапазона таблицы → для покрытых компаний берём ТОЛЬКО таблицу
     (0 где нет строки), чтобы дневные тоталы совпадали с таблицей точь-в-точь. */
  const inSheetSpan = (day: string) =>
    earliestSheetDay != null && latestSheetDay != null && day >= earliestSheetDay && day <= latestSheetDay;

  /* === активные компании (есть саб/клик/строка-из-таблицы в диапазоне) === */
  const inRange = (day: string) => day >= from && day <= to;
  const activeLinks = new Set<number>();
  if (opts.includeEmpty) {
    for (const id of campaignMap.keys()) activeLinks.add(id);
  } else {
    for (const [linkId, m] of subsByLinkDay) {
      for (const day of m.keys()) {
        if (inRange(day)) {
          activeLinks.add(linkId);
          break;
        }
      }
    }
    for (const [linkId, m] of deltaByLinkDay) {
      for (const [day, v] of m) {
        if (inRange(day) && v != null && v > 0) {
          activeLinks.add(linkId);
          break;
        }
      }
    }
    for (const [linkId, m] of sheetByLinkDay) {
      for (const day of m.keys()) {
        if (inRange(day)) {
          activeLinks.add(linkId);
          break;
        }
      }
    }
  }

  /* Группируем кампании по партнёру: сперва партнёр (натурально), внутри — код. */
  const campaigns = [...campaignMap.values()]
    .filter((c) => activeLinks.has(c.link_id))
    .sort((a, b) => {
      const byPartner = naturalCmp(a.partner_name ?? "~", b.partner_name ?? "~");
      if (byPartner !== 0) return byPartner;
      return naturalCmp(a.campaign_code, b.campaign_code);
    });

  /* === строки по дням === */
  const rows: DailyRow[] = [];
  let prevTotalSubs: number | null = null;
  for (const date of days) {
    const cells: Record<string, DailyCell> = {};
    let tClicks = 0;
    let tClicksHas = false;
    let tSubs = 0;
    let tPayout = 0;

    for (const camp of campaigns) {
      const covered = sheetByLinkDay.has(camp.link_id);
      const sheet = sheetByLinkDay.get(camp.link_id)?.get(date);
      let subs: number;
      let clicks: number | null;
      if (covered && inSheetSpan(date)) {
        /* покрыта таблицей и день в её диапазоне → только таблица (0 где нет строки) */
        subs = sheet ? sheet.fans : 0;
        clicks = sheet ? sheet.clicks : 0;
      } else {
        /* другие партнёры или дни вне диапазона таблицы → OM-derived */
        subs = subsByLinkDay.get(camp.link_id)?.get(date) ?? 0;
        const dm = deltaByLinkDay.get(camp.link_id);
        clicks = dm && dm.has(date) ? dm.get(date)! : null;
      }
      const cr = clicks != null && clicks > 0 ? subs / clicks : null;
      const payout = subs * camp.cpf;
      cells[String(camp.link_id)] = { clicks, subs, cr, payout };
      if (clicks != null) {
        tClicks += clicks;
        tClicksHas = true;
      }
      tSubs += subs;
      tPayout += payout;
    }

    const totalClicks = tClicksHas ? tClicks : null;
    const totalCr = totalClicks != null && totalClicks > 0 ? tSubs / totalClicks : null;
    const subsDelta = prevTotalSubs == null ? null : tSubs - prevTotalSubs;
    rows.push({
      date,
      total: { clicks: totalClicks, subs: tSubs, cr: totalCr, payout: tPayout, subs_delta: subsDelta },
      cells,
    });
    prevTotalSubs = tSubs;
  }

  return {
    creator: creator ?? null,
    from,
    to,
    tz: TRACKING_TZ,
    campaigns,
    rows,
    clicks_available_from: [earliestSheetDay, earliestCaptureDay]
      .filter((d): d is string => !!d)
      .sort()[0] ?? null,
  };
}
