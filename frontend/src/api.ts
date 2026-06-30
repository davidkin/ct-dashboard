export interface PartnerLinkSummary {
  partner_id: number;
  creator: string;
  id: number;
  campaign_code: string;
  of_url: string;
  of_created_at: string | null;
  cpf_free: number | null;
  cpf_paid: number | null;
  revshare_pct: number | null;
  clicks_count: number;
  subscribers_count: number;
  spenders_count: number;
  revenue_total: number;
  payout_total: number;
}

export interface PartnerCreatorBreakdown {
  partner_id: number;
  creator: string;
  links_count: number;
  clicks_total: number | null;
  subs_total: number | null;
  spenders_total: number | null;
  revenue_total: number | null;
  payout_total: number | null;
  links: PartnerLinkSummary[];
}

export interface PartnerRow {
  id: number;
  display_name: string;
  glossary_name: string;
  telegram: string | null;
  type: string | null;
  source: string | null;
  monthly_fee: number | null;
  notes: string | null;
  links_count: number;
  clicks_total: number | null;
  subs_total: number | null;
  spenders_total: number | null;
  revenue_total: number | null;
  payout_total: number | null;
  last_synced_at: string | null;
  by_creator: PartnerCreatorBreakdown[];
  sparkline: Array<{ day: string; clicks: number }>;
}

export interface Link {
  id: number;
  partner_id: number;
  creator: string;
  campaign_code: string;
  of_url: string;
  cpf_free: number | null;
  cpf_paid: number | null;
  revshare_pct: number | null;
  source: string | null;
  clicks_count: number | null;
  subscribers_count: number | null;
  spenders_count: number | null;
  revenue_total: number | null;
  of_created_at: string | null;
  last_synced_at: string | null;
}

export interface Partner {
  id: number;
  display_name: string;
  glossary_name: string;
  telegram: string | null;
  type: string | null;
  source: string | null;
  monthly_fee: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PartnerPatch {
  monthly_fee?: number | null;
  notes?: string | null;
}

export interface Creator {
  name: string;
  slug: string;
  links_count: number;
  partners_count: number;
  clicks_total: number | null;
  subs_total: number | null;
  spenders_total: number | null;
  revenue_total: number | null;
  last_synced_at: string | null;
  account_id: string | null;
  configured: boolean;
  avatar: string | null;
  header: string | null;
  of_username: string | null;
}

export interface PartnerTrend {
  id: number;
  display_name: string;
  current: { revenue: number; subs: number; spenders: number; clicks: number; payout: number };
  prior:   { revenue: number; subs: number; spenders: number; clicks: number; payout: number };
  delta:   { revenue: number; subs: number; spenders: number; clicks: number; payout: number };
  delta_pct: { revenue: number | null; subs: number | null; spenders: number | null; clicks: number | null; payout: number | null };
}

export interface TrendsResponse {
  data: PartnerTrend[];
  meta: {
    days: number;
    start?: string;
    end?: string;
    prior_start?: string;
    prior_end?: string;
    history_days: number;
    first_snapshot: string | null;
    last_snapshot: string | null;
    enough_history: boolean;
  };
}

export interface TrendRange {
  start?: string;
  end?: string;
}

export interface CreatorProfile {
  username: string;
  display_name: string;
  is_authenticated: boolean;
  avatar: string | null;
  header: string | null;
  name: string | null;
  posts_count: number | null;
  photos_count: number | null;
  videos_count: number | null;
  is_verified: boolean | null;
  join_date: string | null;
}

export interface CreatorDetail {
  name: string;
  slug: string;
  account_id: string | null;
  configured: boolean;
  aggregate: {
    links_count: number;
    partners_count: number;
    clicks_total: number | null;
    subs_total: number | null;
    spenders_total: number | null;
    revenue_total: number | null;
    last_synced_at: string | null;
  };
  top_partners: Array<{
    id: number;
    display_name: string;
    telegram: string | null;
    type: string | null;
    source: string | null;
    links_count: number;
    clicks_total: number | null;
    subs_total: number | null;
    revenue_total: number | null;
  }>;
  profile: CreatorProfile | null;
  profile_error: string | null;
}

export interface HealthResponse {
  status: string;
  of_api_configured: boolean;
}

export interface LinkSubscriber {
  id: number;
  link_id: number;
  of_fan_id: string;
  username: string | null;
  subscribed_at: string | null;     // OF: subscribedByExpireDate — когда подписка ИСТЕКАЕТ
  is_active: number;
  first_seen_at: string | null;      // когда МЫ впервые увидели → прокси-дата подписки
  fetched_at: string;
}

export interface LinkSpender {
  id: number;
  link_id: number;
  of_fan_id: string;
  username: string | null;
  revenue_total: number;
  calculated_at: string | null;
  first_seen_at: string | null;
  fetched_at: string;
}

export interface Chargeback {
  id: number;
  of_account_id: string;
  of_id: string | null;
  fan_id: string | null;
  fan_username: string | null;
  amount: number | null;
  currency: string | null;
  reason: string | null;
  status: string | null;
  occurred_at: string | null;
  resolved_at: string | null;
  fetched_at: string;
}

export interface Transaction {
  id: number;
  of_account_id: string;
  of_id: string | null;
  fan_id: string | null;
  fan_username: string | null;
  amount: number | null;
  net: number | null;
  currency: string | null;
  type: string | null;
  description: string | null;
  occurred_at: string | null;
  fetched_at: string;
}

export interface Payout {
  id: number;
  of_account_id: string;
  of_id: string | null;
  amount: number | null;
  net: number | null;
  currency: string | null;
  status: string | null;
  requested_at: string | null;
  paid_at: string | null;
  fetched_at: string;
}

export interface WebhookEvent {
  id: number;
  event_type: string;
  of_account_id: string | null;
  received_at: string;
  processed_at: string | null;
  status: string;
  payload_json: string;
  error: string | null;
}

/* === Attribution (Игорь) === */
export interface AttributionPartner {
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

export interface AttributionLink {
  link_id: number;
  campaign_code: string;
  of_url: string;
  creator: string | null;
  partner_id: number | null;
  gross_subscribers: number;
  unique_fans: number;
  first_touch_fans: number;
  repeat_overlap_fans: number;
  spenders: number;
  revenue: number;
  attributed_purchases: number;
  payout_breakdown: {
    link_id: number;
    cpf_component: number;
    revshare_component: number;
    payout_total: number;
    cpf_eligible_fans?: number;
  } | null;
}

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

export interface SyncStatus {
  recent: unknown[];
  links_with_metrics: number;
  of_api_configured: boolean;
}

/* === Daily tracking (аналог ручной таблицы партнёра) === */
export interface DailyCampaign {
  link_id: number;
  campaign_code: string;
  creator: string;
  cpf: number;
  partner_id: number | null;
  partner_name: string | null;
}
export interface DailyCell {
  clicks: number | null; // null = нет baseline (до первого ночного снэпшота)
  subs: number;
  cr: number | null;
  payout: number;
}
export interface DailyRow {
  date: string;
  total: { clicks: number | null; subs: number; cr: number | null; payout: number; subs_delta: number | null };
  cells: Record<string, DailyCell>; // ключ = String(link_id)
}
export interface DailyReport {
  creator: string | null;
  from: string;
  to: string;
  tz: string;
  campaigns: DailyCampaign[];
  rows: DailyRow[];
  clicks_available_from: string | null;
}
export interface DailyCaptureResult {
  day: string;
  links_captured: number;
  links_unmatched: number;
  om_synced: boolean;
  duration_ms: number;
  errors: string[];
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const json = await res.json();
  return json.data as T;
}

function withCreator(url: string, creator?: string): string {
  if (!creator) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}creator=${encodeURIComponent(creator)}`;
}

export const api = {
  health: () => fetch("/api/health").then((r) => r.json() as Promise<HealthResponse>),
  creators: () => get<Creator[]>("/api/creators"),
  creator: (slug: string) => get<CreatorDetail>(`/api/creators/${slug}`),
  trends: async (days = 7, creator?: string, range?: TrendRange): Promise<TrendsResponse> => {
    const url = new URL("/api/trends", window.location.origin);
    if (range?.start || range?.end) {
      if (range.start) url.searchParams.set("start", range.start);
      if (range.end) url.searchParams.set("end", range.end);
      url.searchParams.set("days", String(days));
    } else {
      url.searchParams.set("days", String(days));
    }
    if (creator) url.searchParams.set("creator", creator);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },
  partners: (creator?: string, from?: string, to?: string) => {
    let url = withCreator("/api/partners", creator);
    if (from && to) {
      const sep = url.includes("?") ? "&" : "?";
      url = `${url}${sep}from=${from}&to=${to}`;
    }
    return get<PartnerRow[]>(url);
  },
  partner: (id: number, creator?: string) =>
    get<{ partner: Partner; links: Link[] }>(withCreator(`/api/partners/${id}`, creator)),
  syncStatus: () => get<SyncStatus>("/api/sync/status"),
  forceSync: async () => {
    const res = await fetch("/api/sync", { method: "POST" });
    return res.json();
  },
  linkSubscribers: async (linkId: number, refresh = false): Promise<{ data: LinkSubscriber[]; source: string }> => {
    const r = await fetch(`/api/links/${linkId}/subscribers${refresh ? "?refresh=1" : ""}`);
    if (!r.ok) throw new Error((await r.json()).error || `${r.status}`);
    return r.json();
  },
  linkSpenders: async (linkId: number, refresh = false): Promise<{ data: LinkSpender[]; source: string }> => {
    const r = await fetch(`/api/links/${linkId}/spenders${refresh ? "?refresh=1" : ""}`);
    if (!r.ok) throw new Error((await r.json()).error || `${r.status}`);
    return r.json();
  },
  chargebacks: (days = 30) => get<Chargeback[]>(`/api/chargebacks?days=${days}`),
  transactions: (days = 30) => get<Transaction[]>(`/api/transactions?days=${days}`),
  payouts: () => get<Payout[]>("/api/payouts"),
  webhookEvents: (limit = 50) => get<WebhookEvent[]>(`/api/webhooks/events?limit=${limit}`),
  attributionPartners: (from?: string, to?: string) => {
    const q = from && to ? `?from=${from}&to=${to}` : "";
    return get<AttributionPartner[]>(`/api/attribution/partners${q}`);
  },
  attributionOverview: () => get<AttributionOverview>("/api/attribution/overview"),
  attributionPartnerLinks: (partnerId: number, from?: string, to?: string) => {
    const q = from && to ? `?from=${from}&to=${to}` : "";
    return get<AttributionLink[]>(`/api/attribution/partners/${partnerId}/links${q}`);
  },
  syncFans: async () => {
    const r = await fetch("/api/sync/fans", { method: "POST" });
    return r.json();
  },
  pullAllSubscribers: async (force = false) => {
    const r = await fetch(`/api/sync/all-subscribers${force ? "?force=1" : ""}`, { method: "POST" });
    return r.json();
  },
  forceFinanceSync: async () => {
    const r = await fetch("/api/finance/sync", { method: "POST" });
    return r.json();
  },
  dailyTracking: (opts: { creator?: string; from?: string; to?: string; all?: boolean; partner?: number } = {}) => {
    const u = new URL("/api/daily-tracking", window.location.origin);
    if (opts.creator) u.searchParams.set("creator", opts.creator);
    if (opts.from) u.searchParams.set("from", opts.from);
    if (opts.to) u.searchParams.set("to", opts.to);
    if (opts.all) u.searchParams.set("all", "1");
    if (opts.partner) u.searchParams.set("partner", String(opts.partner));
    return get<DailyReport>(u.pathname + u.search);
  },
  dailyCapture: async (): Promise<{ data?: DailyCaptureResult; error?: string }> => {
    const r = await fetch("/api/daily-tracking/capture", { method: "POST" });
    return r.json();
  },
  dailyImportSheet: async (): Promise<{ data?: unknown; error?: string }> => {
    const r = await fetch("/api/daily-tracking/import-sheet", { method: "POST" });
    return r.json();
  },
  updatePartner: async (id: number, patch: PartnerPatch): Promise<Partner> => {
    const res = await fetch(`/api/partners/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = await res.json();
    return json.data as Partner;
  },
};
