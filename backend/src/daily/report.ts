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
import { localDay, dayRange, TRACKING_TZ, todayLocal, nextCaptureAt } from "../lib/tz";

export interface DailyCampaign {
  link_id: number;
  campaign_code: string;
  creator: string;
  /** free | paid — по коду (camp_paid_* = paid). Для фильтра/скоркардов на фронте. */
  tier: "free" | "paid";
  cpf: number;
  revshare: number | null;
  partner_id: number | null;
  partner_name: string | null;
}

/** Итог по клики+фаны (для скоркардов и снапшот-блока). */
export interface TierTotals {
  clicks: number;
  fans: number;
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
  /** тоталы клики+фаны за период, разбитые по типу (для скоркардов вне таблицы) */
  summary: { free: TierTotals; paid: TierTotals; all: TierTotals };
  /** блок «сегодня»: последний снепшот + таймер до следующего */
  snapshot: {
    tz: string;
    today: string;
    /** локальное время ночного джоба, напр. "23:59" */
    capture_time: string;
    /** ISO (UTC) следующего снепшота — фронт считает обратный отсчёт */
    next_capture_at: string;
    /** день последнего снятого снепшота (обычно вчера) */
    last_snapshot_day: string | null;
    /** тотал за день последнего снепшота */
    last_snapshot: TierTotals;
  };
}

interface BuildOpts {
  creator: string | null;
  from: string;
  to: string;
  /** фильтр по партнёру (partners.id); null = все партнёры */
  partner?: number | null;
  includeEmpty?: boolean;
  /** только точный слепок таблицы (daily_sheet_stats), без OM/OF fallback */
  sheetOnly?: boolean;
  /** "combined" — авто-снимок (дельта cum) где есть, иначе импорт листа, иначе пусто */
  source?: "combined";
  /** фильтр по типу кампаний: free | paid | undefined(все) */
  tier?: "free" | "paid";
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
              l.revshare_pct, l.partner_id, p.display_name AS partner_name,
              p.cpf_free AS p_cpf_free, p.cpf_paid AS p_cpf_paid
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
      revshare_pct: number | null;
      partner_id: number | null;
      partner_name: string | null;
      p_cpf_free: number | null;
      p_cpf_paid: number | null;
    }>;

  const campaignMap = new Map<number, DailyCampaign>();
  for (const r of linkRows) {
    const tier: "free" | "paid" = r.campaign_code.startsWith("camp_paid") ? "paid" : "free";
    if (opts.tier && tier !== opts.tier) continue; // фильтр free/paid
    /* CPF берём с ПАРТНЁРА (Free/Paid CPF), фолбэк на CPF линка (для старых данных). */
    campaignMap.set(r.link_id, {
      link_id: r.link_id,
      campaign_code: r.campaign_code,
      creator: r.creator,
      tier,
      cpf: pickCpf(r.creator, r.p_cpf_free ?? r.cpf_free, r.p_cpf_paid ?? r.cpf_paid),
      revshare: r.revshare_pct,
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

  /* === авто-снимок: дельты кликов И фанов из накопительного счётчика (Raw-слой) === */
  const clickRows = db
    .prepare(
      `SELECT dc.link_id, dc.day, dc.clicks_cumulative, dc.fans_cumulative
       FROM daily_link_clicks dc JOIN links l ON l.id = dc.link_id
       WHERE (@creator IS NULL OR l.creator = @creator)
         AND (@partner IS NULL OR l.partner_id = @partner)
       ORDER BY dc.link_id, dc.day`,
    )
    .all({ creator: creator ?? null, partner }) as Array<{
      link_id: number;
      day: string;
      clicks_cumulative: number;
      fans_cumulative: number | null;
    }>;

  const cumulByLink = new Map<number, Array<{ day: string; clicks: number; fans: number | null }>>();
  for (const c of clickRows) {
    let arr = cumulByLink.get(c.link_id);
    if (!arr) {
      arr = [];
      cumulByLink.set(c.link_id, arr);
    }
    arr.push({ day: c.day, clicks: c.clicks_cumulative, fans: c.fans_cumulative });
  }

  /* дельта кликов (для дней вне диапазона листа — OM-derived clicks) */
  const deltaByLinkDay = new Map<number, Map<string, number | null>>();
  let earliestCaptureDay: string | null = null;
  for (const [linkId, arr] of cumulByLink) {
    const m = new Map<string, number | null>();
    for (let i = 0; i < arr.length; i++) {
      if (i === 0) {
        m.set(arr[i].day, null); // первый снэпшот — нет baseline
      } else {
        const dc = arr[i].clicks - arr[i - 1].clicks;
        m.set(arr[i].day, dc >= 0 ? dc : null); // сброс счётчика → неизвестно
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

  /* === замороженные подневные OM-значения (клики+фаны ЗА ДЕНЬ, посчитаны при записи) ===
     Читаем как есть, без пересчёта. Дополняют сид на дни ПОСЛЕ его конца. */
  const omDailyByLinkDay = new Map<number, Map<string, { clicks: number; fans: number }>>();
  for (const s of db
    .prepare(
      `SELECT do2.link_id, do2.day, do2.clicks, do2.fans
       FROM daily_om_stats do2 JOIN links l ON l.id = do2.link_id
       WHERE (@creator IS NULL OR l.creator = @creator)
         AND (@partner IS NULL OR l.partner_id = @partner)`,
    )
    .all({ creator: creator ?? null, partner }) as Array<{
      link_id: number;
      day: string;
      clicks: number;
      fans: number;
    }>) {
    let m = omDailyByLinkDay.get(s.link_id);
    if (!m) { m = new Map(); omDailyByLinkDay.set(s.link_id, m); }
    m.set(s.day, { clicks: s.clicks, fans: s.fans });
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
  /* тоталы за период по типу (для скоркардов вне таблицы) */
  const sum = {
    free: { clicks: 0, fans: 0 },
    paid: { clicks: 0, fans: 0 },
    all: { clicks: 0, fans: 0 },
  };
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
      if (opts.source === "combined") {
        /* Чистая модель: читаем ЗАМОРОЖЕННЫЕ подневные значения, без дельт на чтении.
           Сид (ручная таблица) — истина на своём диапазоне; дальше — подневные OM-значения,
           посчитанные и замороженные при ночной записи. Ничего не пересчитываем. */
        const omDaily = omDailyByLinkDay.get(camp.link_id)?.get(date);
        if (sheet) {
          clicks = sheet.clicks;
          subs = sheet.fans;
        } else if (omDaily) {
          clicks = omDaily.clicks;
          subs = omDaily.fans;
        } else {
          clicks = null;
          subs = 0;
        }
      } else if (opts.sheetOnly) {
        /* точный слепок: только таблица, без OM/OF. Нет строки → пусто (клики null, фаны 0). */
        subs = sheet ? sheet.fans : 0;
        clicks = sheet ? sheet.clicks : null;
      } else if (covered && inSheetSpan(date)) {
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
      /* накопление per-tier тоталов за период */
      const bucket = sum[camp.tier];
      bucket.clicks += clicks ?? 0;
      bucket.fans += subs;
      sum.all.clicks += clicks ?? 0;
      sum.all.fans += subs;
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

  /* последний снятый снепшот = последний день с данными (обычно вчера) */
  let lastSnapshotDay: string | null = null;
  let lastSnapshot: TierTotals = { clicks: 0, fans: 0 };
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = rows[i].total;
    if (t.clicks != null || t.subs > 0) {
      lastSnapshotDay = rows[i].date;
      lastSnapshot = { clicks: t.clicks ?? 0, fans: t.subs };
      break;
    }
  }
  const captureTime = process.env.DAILY_CAPTURE_AT || "23:59";

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
    summary: sum,
    snapshot: {
      tz: TRACKING_TZ,
      today: todayLocal(),
      capture_time: captureTime,
      next_capture_at: nextCaptureAt(captureTime),
      last_snapshot_day: lastSnapshotDay,
      last_snapshot: lastSnapshot,
    },
  };
}
