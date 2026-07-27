/**
 * Кумулятивные тоталы кликов/фанов по трафик-линкам ИЗ OM — единственный
 * источник истины по тоталам (по договорённости). Кэш в памяти (TTL), чтобы
 * не дёргать OM API на каждый рендер (по ~100 линков на аккаунт × 2).
 */
import { listTrackingLinks } from "./client";

export interface OmLinkTotal {
  campaign_code: string;
  tracking_id: string;
  clicks: number;
  subscribers: number;
  account: "free" | "vip";
}

let cache: { at: number; data: Map<string, OmLinkTotal> } | null = null;
const TTL_MS = 10 * 60 * 1000;

/** campaign_code → OM cumulative { clicks, subscribers }. Кэшируется на TTL_MS. */
export async function getOmLinkTotals(force = false): Promise<Map<string, OmLinkTotal>> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const freeAcct = process.env.ONLYMONSTER_ACCOUNT_FREE;
  const vipAcct = process.env.ONLYMONSTER_ACCOUNT_VIP;
  const m = new Map<string, OmLinkTotal>();

  const pull = async (acct: string | undefined, tag: "free" | "vip") => {
    if (!acct) return;
    const links = await listTrackingLinks(acct);
    for (const l of links) {
      if (!l.name) continue;
      m.set(l.name, {
        campaign_code: l.name,
        tracking_id: String(l.id),
        clicks: l.clicks ?? 0,
        subscribers: l.subscribers ?? 0,
        account: tag,
      });
    }
  };

  await pull(freeAcct, "free");
  await pull(vipAcct, "vip");

  cache = { at: Date.now(), data: m };
  return m;
}

export function omTotalsCacheAgeMs(): number | null {
  return cache ? Date.now() - cache.at : null;
}
