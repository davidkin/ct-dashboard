import type { DailyReport } from "../api";

export type CampSortKey = "code" | "clicks" | "fans" | "cr" | "payout";
export interface CampSort {
  key: CampSortKey;
  dir: "asc" | "desc";
}
export const DEFAULT_CAMP_SORT: CampSort = { key: "code", dir: "asc" };

export interface CampAgg {
  link_id: number;
  code: string;
  tier: "free" | "paid";
  of_url: string;
  clicks: number;
  fans: number;
  payout: number;
}

/** Сумма кликов/фанов/выплаты по каждой кампании за период отчёта + сортировка.
    Общий код для карточки партнёра (админ) и личного кабинета траффера (публично). */
export function aggregateCampaigns(rep: DailyReport | null, sort: CampSort): CampAgg[] {
  if (!rep) return [];
  const agg = new Map<number, CampAgg>();
  for (const c of rep.campaigns) {
    agg.set(c.link_id, {
      link_id: c.link_id,
      code: c.campaign_code,
      tier: c.tier,
      of_url: c.of_url,
      clicks: 0,
      fans: 0,
      payout: 0,
    });
  }
  for (const row of rep.rows) {
    for (const c of rep.campaigns) {
      const cell = row.cells[String(c.link_id)];
      if (!cell) continue;
      const a = agg.get(c.link_id)!;
      a.clicks += cell.clicks ?? 0;
      a.fans += cell.subs;
      a.payout += cell.payout;
    }
  }
  const list = [...agg.values()];
  const sign = sort.dir === "asc" ? 1 : -1;
  const cr = (c: CampAgg) => (c.clicks > 0 ? c.fans / c.clicks : 0);
  list.sort((a, b) => {
    switch (sort.key) {
      case "clicks":
        return sign * (a.clicks - b.clicks);
      case "fans":
        return sign * (a.fans - b.fans);
      case "cr":
        return sign * (cr(a) - cr(b));
      case "payout":
        return sign * (a.payout - b.payout);
      default: {
        /* free перед paid, внутри группы — по номеру, а не по алфавиту. */
        const paidA = a.tier === "paid" ? 1 : 0;
        const paidB = b.tier === "paid" ? 1 : 0;
        if (paidA !== paidB) return sign * (paidA - paidB);
        return sign * a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: "base" });
      }
    }
  });
  return list;
}

export function campaignTotals(campaigns: CampAgg[]) {
  const t = campaigns.reduce(
    (s, c) => ({ clicks: s.clicks + c.clicks, fans: s.fans + c.fans, payout: s.payout + c.payout }),
    { clicks: 0, fans: 0, payout: 0 },
  );
  return { ...t, cr: t.clicks > 0 ? t.fans / t.clicks : null };
}
