const BASE = "https://app.onlyfansapi.com";

export interface OFTrackingLink {
  id: number;
  campaignCode: number;
  campaignName: string;
  campaignUrl: string;
  subscribersCount: number;
  clicksCount: number;
  createdAt: string;
  endDate: string | null;
  tags: string[];
  revenue: {
    total: number;
    revenuePerSubscriber: number;
    revenuePerClick: number;
    spendersCount: number;
    calculatedAt: string;
    isLoading: boolean;
  };
}

export interface OFAccount {
  id: string;
  display_name: string;
  onlyfans_id: string;
  onlyfans_username: string;
  is_authenticated: boolean;
  onlyfans_user_data?: {
    id: number;
    name: string;
    username: string;
    avatar: string;
    header: string;
    about: string;
    postsCount?: number;
    photosCount?: number;
    videosCount?: number;
    isVerified?: boolean;
    joinDate?: string;
  };
}

/**
 * Subscribers endpoint возвращает ПОЛНЫЙ OF user-объект.
 * Тут — только поля которые мы реально храним; остальные игнорим.
 */
export interface OFTrackingLinkSubscriber {
  id: number;
  username: string;
  displayName?: string;
  isActive?: boolean;
  subscribedByExpireDate?: string | null;
  subscribedByAutoprolong?: boolean;
  currentSubscribePrice?: number;
  [key: string]: unknown;
}

export interface OFTrackingLinkSpender {
  onlyfans_id: string;
  username: string;
  revenue: { total: number; calculated_at: string };
}

export interface OFChargeback {
  id?: string | number;
  fan_id?: string | number;
  fan_username?: string;
  amount?: number;
  currency?: string;
  reason?: string;
  status?: string;
  created_at?: string;
  resolved_at?: string;
  /* раз отдают полем-варейшен, не закладываемся жестко — храним JSON-копию */
  [key: string]: unknown;
}

export interface OFTransaction {
  id?: string | number;
  fan_id?: string | number;
  fan_username?: string;
  amount?: number;
  net?: number;
  currency?: string;
  type?: string;
  description?: string;
  created_at?: string;
  /* ленивее: храним полный объект как JSON */
  [key: string]: unknown;
}

export interface OFPayout {
  id?: string | number;
  amount?: number;
  net?: number;
  currency?: string;
  status?: string;
  created_at?: string;
  paid_at?: string;
  [key: string]: unknown;
}

export interface OFSmartLink {
  id: string;
  name: string;
  link_type: "free_trial" | "tracking_link";
  traffic_redirect_url: string;
  free_trial_days: number | null;
  clicks_count: number;
  conversions_count: number;
  subscribers_count: number;
  spenders_count: number;
  revenue: string | number;
  account?: { id: string; display_name?: string; username?: string };
  created_at?: string;
  updated_at?: string;
}

function authHeaders(): Record<string, string> {
  const key = process.env.ONLYFANSAPI_KEY;
  if (!key) throw new Error("ONLYFANSAPI_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
}

async function request<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OF API ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function listAccounts(): Promise<OFAccount[]> {
  return await request<OFAccount[]>(`${BASE}/api/accounts`);
}

/**
 * Получить один аккаунт. OnlyFansAPI отдаёт все аккаунты массивом по /api/accounts,
 * отдельного эндпоинта по id нет — фильтруем на нашей стороне.
 */
export async function getAccount(accountId: string): Promise<OFAccount | null> {
  const all = await listAccounts();
  return all.find((a) => a.id === accountId) ?? null;
}

export interface OFListResponse<T> {
  data: { list: T[]; hasMore: boolean };
  _pagination?: { next_page?: string };
  _meta?: {
    _credits?: { used: number; balance: number };
    _rate_limits?: { remaining_minute: number; remaining_day: number };
  };
}

/**
 * Получить ВСЕ tracking links для аккаунта (с пагинацией).
 * Endpoint стоит 1 кредит за запрос (по 50 ссылок в пачке).
 */
export async function listAllTrackingLinks(accountId: string): Promise<OFTrackingLink[]> {
  const all: OFTrackingLink[] = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await request<OFListResponse<OFTrackingLink>>(
      `${BASE}/api/${accountId}/tracking-links?limit=${limit}&offset=${offset}`,
    );
    all.push(...res.data.list);
    if (!res.data.hasMore) break;
    offset += limit;
    if (offset > 10000) break;
  }
  return all;
}

interface SimpleListResponse<T> {
  data: T[];
  _meta?: { _credits?: { used: number; balance: number } };
}

/**
 * GET /api/{acct}/tracking-links/{id}/subscribers
 * Кто подписался по конкретной ссылке.
 * Возвращает { data: { list: [...] } } — обёрнут так же как tracking-links.
 * Минимальный limit на стороне OF API = 10, поднимаем если меньше.
 * Делаем full pagination — тянем ВСЕ страницы до hasMore=false.
 */
export async function listTrackingLinkSubscribers(
  accountId: string,
  trackingLinkId: number,
  limit = 100,
  offset = 0,
): Promise<OFTrackingLinkSubscriber[]> {
  const all: OFTrackingLinkSubscriber[] = [];
  const pageSize = Math.max(10, limit);
  let cur = offset;
  while (true) {
    const res = await request<{ data: { list: OFTrackingLinkSubscriber[]; hasMore?: boolean } }>(
      `${BASE}/api/${accountId}/tracking-links/${trackingLinkId}/subscribers?limit=${pageSize}&offset=${cur}`,
    );
    const list = res.data?.list ?? [];
    all.push(...list);
    if (!res.data?.hasMore || list.length === 0) break;
    cur += list.length;
    if (cur > 50000) break;
  }
  return all;
}

/**
 * GET /api/{acct}/tracking-links/{id}/spenders
 * Кто заплатил по конкретной ссылке (отсортировано по сумме).
 * Также тянем все страницы.
 */
export async function listTrackingLinkSpenders(
  accountId: string,
  trackingLinkId: number,
  limit = 100,
  offset = 0,
  minSpend = 1,
): Promise<OFTrackingLinkSpender[]> {
  const all: OFTrackingLinkSpender[] = [];
  const pageSize = Math.max(10, limit);
  let cur = offset;
  while (true) {
    const res = await request<SimpleListResponse<OFTrackingLinkSpender>>(
      `${BASE}/api/${accountId}/tracking-links/${trackingLinkId}/spenders?limit=${pageSize}&offset=${cur}&minSpend=${minSpend}`,
    );
    const list = res.data ?? [];
    all.push(...list);
    if (list.length < pageSize) break;
    cur += list.length;
    if (cur > 50000) break;
  }
  return all;
}

/**
 * GET /api/{acct}/chargebacks
 * Возвраты / диспуты — для расчёта реальной прибыли и quality score партнёра.
 */
export async function listChargebacks(accountId: string): Promise<OFChargeback[]> {
  /* OF API в этом endpoint может отдавать paginated. Тянем всё на нашу сторону. */
  const all: OFChargeback[] = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await request<SimpleListResponse<OFChargeback>>(
      `${BASE}/api/${accountId}/chargebacks?limit=${limit}&offset=${offset}`,
    );
    const batch = res.data ?? [];
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    if (offset > 10000) break;
  }
  return all;
}

/**
 * GET /api/{acct}/transactions
 * Гранулярная финансовая активность.
 */
export async function listTransactions(accountId: string, sinceDays = 30): Promise<OFTransaction[]> {
  const all: OFTransaction[] = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await request<SimpleListResponse<OFTransaction>>(
      `${BASE}/api/${accountId}/transactions?limit=${limit}&offset=${offset}&sinceDays=${sinceDays}`,
    );
    const batch = res.data ?? [];
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    if (offset > 20000) break;
  }
  return all;
}

/**
 * GET /api/{acct}/payouts
 * Когда модель получила деньги от OF.
 */
export async function listPayouts(accountId: string): Promise<OFPayout[]> {
  const res = await request<SimpleListResponse<OFPayout>>(
    `${BASE}/api/${accountId}/payouts?limit=100`,
  );
  return res.data ?? [];
}

/**
 * GET /api/smart-links
 * Альтернативная система pixel-based трекинга (живёт параллельно с tracking-links).
 */
export async function listSmartLinks(accountId?: string): Promise<OFSmartLink[]> {
  const q = accountId ? `?account_ids=${accountId}` : "";
  const res = await request<{ data: OFSmartLink[] }>(
    `${BASE}/api/smart-links${q}`,
  );
  return res.data ?? [];
}
