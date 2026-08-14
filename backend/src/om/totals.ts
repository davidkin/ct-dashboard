/**
 * Кумулятивные тоталы кликов/фанов по трафик-линкам ИЗ OM — единственный
 * источник истины по тоталам (по договорённости). Кэш в памяти (TTL), чтобы
 * не дёргать OM API на каждый рендер (по ~100 линков на аккаунт × 2).
 *
 * Ключ — пара "модель::campaign_code": код кампании уникален только внутри
 * модели (у Lily нумерация начинается заново и пересекается с Nekoletta).
 */
import { listTrackingLinks } from "./client";
import { getModelGroup, getOMAccountForCreator, listModels, creatorsInModelGroup } from "../config/creators";

export interface OmLinkTotal {
  campaign_code: string;
  model: string;
  tracking_id: string;
  clicks: number;
  subscribers: number;
  account: "free" | "vip";
}

let cache: { at: number; data: Map<string, OmLinkTotal> } | null = null;
const TTL_MS = 10 * 60 * 1000;

/** Ключ кэша тоталов: модель + код кампании. */
export function omTotalsKey(model: string | null | undefined, campaignCode: string): string {
  return `${model ?? ""}::${campaignCode}`;
}

/** "модель::campaign_code" → OM cumulative { clicks, subscribers }. Кэшируется на TTL_MS. */
export async function getOmLinkTotals(force = false): Promise<Map<string, OmLinkTotal>> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const m = new Map<string, OmLinkTotal>();

  for (const { group } of listModels()) {
    for (const creator of creatorsInModelGroup(group)) {
      const acct = getOMAccountForCreator(creator);
      if (!acct) continue;
      const tag: "free" | "vip" = creator.toLowerCase().endsWith("vip") ? "vip" : "free";
      const links = await listTrackingLinks(acct);
      for (const l of links) {
        if (!l.name) continue;
        m.set(omTotalsKey(getModelGroup(creator), l.name), {
          campaign_code: l.name,
          model: group,
          tracking_id: String(l.id),
          clicks: l.clicks ?? 0,
          subscribers: l.subscribers ?? 0,
          account: tag,
        });
      }
    }
  }

  cache = { at: Date.now(), data: m };
  return m;
}

export function omTotalsCacheAgeMs(): number | null {
  return cache ? Date.now() - cache.at : null;
}
