/**
 * Кумулятивные тоталы кликов/фанов по трафик-линкам ИЗ OM — единственный
 * источник истины по тоталам (по договорённости). Кэш в памяти (TTL), чтобы
 * не дёргать OM API на каждый рендер (по ~100 линков на аккаунт × 2).
 *
 * Ключ — пара "модель::campaign_code": код кампании уникален только внутри
 * модели (у Lily нумерация начинается заново и пересекается с Nekoletta).
 */
import { listTrackingLinks } from "./client";
import { getModelGroup, getOMAccountForCreator, listModels, creatorsInModelGroup, isRetiredModel } from "../config/creators";

export interface OmLinkTotal {
  campaign_code: string;
  model: string;
  tracking_id: string;
  clicks: number;
  subscribers: number;
  account: "free" | "vip";
}

let cache: { at: number; data: Map<string, OmLinkTotal> } | null = null;
let lastErrors: string[] = [];
const TTL_MS = 10 * 60 * 1000;

/**
 * Ключ кэша тоталов: модель + тир + код кампании.
 * Тир обязателен: в VIP-аккаунте часть линков названа как во free (camp_79,
 * а не camp_paid_79) — без тира vip затирал бы free в мапе.
 */
export function omTotalsKey(
  model: string | null | undefined,
  tier: "free" | "vip",
  campaignCode: string,
): string {
  return `${model ?? ""}::${tier}::${campaignCode}`;
}

export function tierForCreator(creator: string | null | undefined, campaignCode: string): "free" | "vip" {
  if (creator) return creator.toLowerCase().endsWith("vip") ? "vip" : "free";
  return campaignCode.startsWith("camp_paid_") ? "vip" : "free";
}

/**
 * Найти OM-тотал для нашего линка. У vip-линков код в глоссарии — camp_paid_N,
 * а в OM линк может называться и camp_paid_N, и просто camp_N — пробуем оба.
 */
export function findOmTotal(
  m: Map<string, OmLinkTotal>,
  model: string | null | undefined,
  creator: string | null | undefined,
  campaignCode: string,
): OmLinkTotal | null {
  const tier = tierForCreator(creator, campaignCode);
  const candidates =
    tier === "vip" ? [campaignCode, campaignCode.replace(/^camp_paid_/, "camp_")] : [campaignCode];
  for (const code of candidates) {
    const hit = m.get(omTotalsKey(model, tier, code));
    if (hit) return hit;
  }
  return null;
}

/** "модель::campaign_code" → OM cumulative { clicks, subscribers }. Кэшируется на TTL_MS. */
export async function getOmLinkTotals(force = false): Promise<Map<string, OmLinkTotal>> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const m = new Map<string, OmLinkTotal>();

  const failed: string[] = [];

  /* скрытые модели тоже тянем: сверка и синк должны видеть все аккаунты */
  for (const { group } of listModels(true)) {
    if (isRetiredModel(group)) continue;   // доступ к OM отобран — сверять нечего
    for (const creator of creatorsInModelGroup(group)) {
      const acct = getOMAccountForCreator(creator);
      if (!acct) continue;
      const tag: "free" | "vip" = creator.toLowerCase().endsWith("vip") ? "vip" : "free";
      /* Аккаунт отвалившейся модели (у организации отобрали доступ) не должен
         ронять всю сверку — пропускаем его и продолжаем с остальными. */
      let links: Awaited<ReturnType<typeof listTrackingLinks>>;
      try {
        links = await listTrackingLinks(acct);
      } catch (err) {
        failed.push(`${creator}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const l of links) {
        if (!l.name) continue;
        m.set(omTotalsKey(getModelGroup(creator), tag, l.name), {
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
  lastErrors = failed;
  return m;
}

export function omTotalsCacheAgeMs(): number | null {
  return cache ? Date.now() - cache.at : null;
}

/** Аккаунты, которые не удалось прочитать в последнюю выгрузку (403 у отвалившейся
 *  модели и т.п.) — сверка по ним неполная, UI должен это показать. */
export function omTotalsErrors(): string[] {
  return lastErrors;
}
