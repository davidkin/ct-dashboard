/**
 * OnlyMonster CRM API client.
 *
 * Ключевое отличие от OnlyFansAPI: отдаёт РЕАЛЬНУЮ `subscribed_at` дату подписки
 * (а не expiry), плюс transactions с amount + fan.id + timestamp.
 *
 * Auth: header `x-om-auth-token`.
 * Rate limit: 25 req/s глобально, 15/endpoint (default). Cursor-based пагинация.
 * platform_account_id = OnlyFans numeric id (совпадает с onlyfans_id из OnlyFansAPI).
 */
const BASE = "https://omapi.onlymonster.ai";
const PLATFORM = "onlyfans";

export interface OMTrackingLink {
  id: string;
  name: string;
  subscribers: number;
  url: string;
  is_active: boolean;
  clicks: number;
  created_at: string;
}

export interface OMTrackingLinkUser {
  link_id: string;
  fan: { id: string; name: string; username: string };
  subscribed_at: string;   // ← РЕАЛЬНАЯ дата подписки (ISO 8601)
  collected_at: string;
}

export interface OMTransaction {
  id: string;
  amount: number;
  fan: { id: string };
  type: string;            // Subscription / Tip / Message / Post / Stream / unknown
  status: string;          // done / loading / pending return
  timestamp: string;
}

export interface OMChargeback {
  id: string;
  amount: number;
  fan: { id: string };
  type: string;
  status: string;
  chargeback_timestamp: string;
  transaction_timestamp: string;
}

export interface OMAccount {
  id: number;
  platform_account_id: string;
  platform: string;
  name: string;
  email: string | null;
  avatar: string;
  username: string;
  organisation_id: string;
  subscribe_price: number | null;
  subscription_expiration_date: string | null;
}

function authHeaders(): Record<string, string> {
  const token = process.env.ONLYMONSTER_TOKEN;
  if (!token) throw new Error("ONLYMONSTER_TOKEN not set");
  return { "x-om-auth-token": token, Accept: "application/json" };
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (res.status === 429) throw new Error("OM API 429: rate limit exceeded");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OM API ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

const isoNow = () => new Date().toISOString();
const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

interface CursorResponse<T> {
  items: T[];
  cursor?: string;
}

/** Тянет все страницы cursor-based endpoint-а. */
async function paginate<T>(buildPath: (cursor?: string) => string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let guard = 0;
  while (guard++ < 500) {
    const res = await request<CursorResponse<T>>(buildPath(cursor));
    all.push(...(res.items ?? []));
    if (!res.cursor) break;
    cursor = res.cursor;
  }
  return all;
}

export async function listAccounts(): Promise<OMAccount[]> {
  const res = await request<{ accounts: OMAccount[] }>(`/api/v0/accounts?limit=1000`);
  return res.accounts ?? [];
}

/**
 * tracking-link-users — кто подписался по трекинг-ссылкам, с РЕАЛЬНОЙ subscribed_at.
 * Фильтр collected_from/collected_to — по дате сбора (не подписки!), поэтому
 * по умолчанию тянем всё и фильтруем по subscribed_at на нашей стороне.
 */
export async function listTrackingLinkUsers(
  platformAccountId: string,
  opts: { linkId?: string; limit?: number } = {},
): Promise<OMTrackingLinkUser[]> {
  const limit = opts.limit ?? 750;
  return paginate<OMTrackingLinkUser>((cursor) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (opts.linkId) p.set("link_id", opts.linkId);
    if (cursor) p.set("cursor", cursor);
    return `/api/v0/platforms/${PLATFORM}/accounts/${platformAccountId}/tracking-link-users?${p}`;
  });
}

/** tracking-links — список ссылок с агрегатами (subscribers/clicks). */
export async function listTrackingLinks(
  platformAccountId: string,
  opts: { start?: string; end?: string; limit?: number } = {},
): Promise<OMTrackingLink[]> {
  const start = opts.start ?? isoDaysAgo(365);
  const end = opts.end ?? isoNow();
  const limit = opts.limit ?? 1000;
  return paginate<OMTrackingLink>((cursor) => {
    const p = new URLSearchParams({ start, end, limit: String(limit) });
    if (cursor) p.set("cursor", cursor);
    return `/api/v0/platforms/${PLATFORM}/accounts/${platformAccountId}/tracking-links?${p}`;
  });
}

/** transactions — выручка с fan.id + timestamp. Для RevShare-компонента. */
export async function listTransactions(
  platformAccountId: string,
  opts: { start?: string; end?: string; limit?: number } = {},
): Promise<OMTransaction[]> {
  const start = opts.start ?? isoDaysAgo(90);
  const end = opts.end ?? isoNow();
  const limit = opts.limit ?? 1000;
  return paginate<OMTransaction>((cursor) => {
    const p = new URLSearchParams({ start, end, limit: String(limit) });
    if (cursor) p.set("cursor", cursor);
    return `/api/v0/platforms/${PLATFORM}/accounts/${platformAccountId}/transactions?${p}`;
  });
}

/** chargebacks — возвраты/диспуты с fan.id. */
export async function listChargebacks(
  platformAccountId: string,
  opts: { start?: string; end?: string; limit?: number } = {},
): Promise<OMChargeback[]> {
  const start = opts.start ?? isoDaysAgo(365);
  const end = opts.end ?? isoNow();
  const limit = opts.limit ?? 1000;
  return paginate<OMChargeback>((cursor) => {
    const p = new URLSearchParams({ start, end, limit: String(limit) });
    if (cursor) p.set("cursor", cursor);
    return `/api/v0/platforms/${PLATFORM}/accounts/${platformAccountId}/chargebacks?${p}`;
  });
}
