/**
 * Notion: базы Partners (кошельки) и Payments (инвойсы выплат партнёрам).
 *
 * Партнёр в Notion — заголовок «@ник» (иногда без @), выплата — «@ник-A3»:
 * буква = модель в Notion (Anita = Kimi, MARIA = Nikki), число = номер инвойса
 * партнёра по этой модели. Связь с дашбордом — по нику, без хранения id у нас.
 */
const BASE = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

/** Модель дашборда → значение select «Model» в Payments. */
export const NOTION_MODEL: Record<string, string> = {
  Kimi: "Anita",
  Nikki: "MARIA",
};

export interface NotionPartner {
  id: string;
  url: string;
  name: string;
  wallet: string;
  chain: string | null;
  type: string | null;
  note: string;
}

export interface NotionPayment {
  id: string;
  url: string;
  title: string;
  model: string | null;
  date: string | null;
  status: string | null;
  fans: number | null;
  amount: number | null;
  tx_link: string;
  notes: string;
  partner_ids: string[];
  created_time: string;
}

function config() {
  return {
    token: process.env.NOTION_TOKEN ?? "",
    partnersDb: process.env.NOTION_PARTNERS_DB ?? "",
    paymentsDb: process.env.NOTION_PAYMENTS_DB ?? "",
  };
}

export function isNotionConfigured(): boolean {
  const c = config();
  return !!(c.token && c.partnersDb && c.paymentsDb);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config().token}`,
      "Notion-Version": VERSION,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(`Notion ${res.status}: ${json.message ?? "request failed"}`);
  return json as T;
}

interface Page {
  id: string;
  url: string;
  created_time: string;
  properties: Record<string, any>;
}

async function queryAll(dbId: string): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | undefined;
  do {
    const r = await call<{ results: Page[]; has_more: boolean; next_cursor: string | null }>(
      "POST",
      `/databases/${dbId}/query`,
      { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    );
    out.push(...r.results);
    cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** Ник для заголовков в Notion: без @ и с исходным регистром. */
const handle = (nick: string) => nick.trim().replace(/^@/, "");

const text = (p: any): string => (p?.title ?? p?.rich_text ?? []).map((t: any) => t.plain_text).join("");
const selectName = (p: any): string | null => p?.select?.name ?? p?.status?.name ?? null;

/** «@Nick», «nick», «@nick-A3» → «nick». */
export function nickKey(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/-[A-Za-z]+\d+$/, "").replace(/^@/, "").toLowerCase();
}

function toPartner(p: Page): NotionPartner {
  const pr = p.properties;
  return {
    id: p.id,
    url: p.url,
    name: text(pr.Partner),
    wallet: text(pr.Wallet),
    chain: selectName(pr.Chain),
    type: selectName(pr.Type),
    note: text(pr.Note),
  };
}

function toPayment(p: Page): NotionPayment {
  const pr = p.properties;
  return {
    id: p.id,
    url: p.url,
    title: text(pr.Payment),
    model: selectName(pr.Model),
    date: pr.Date?.date?.start ?? null,
    status: selectName(pr.Status),
    fans: pr.Fans?.number ?? null,
    amount: pr.Amount?.number ?? null,
    tx_link: text(pr["TH Link"]),
    notes: text(pr.Notes),
    partner_ids: (pr.Partner?.relation ?? []).map((r: { id: string }) => r.id),
    created_time: p.created_time,
  };
}

export async function findPartner(nick: string): Promise<NotionPartner | null> {
  const key = nickKey(nick);
  if (!key) return null;
  const pages = await queryAll(config().partnersDb);
  const hit = pages.find((p) => nickKey(text(p.properties.Partner)) === key);
  return hit ? toPartner(hit) : null;
}

export async function listAllPayments(): Promise<NotionPayment[]> {
  return (await queryAll(config().paymentsDb)).map(toPayment);
}

/**
 * Сумма невыплаченного (всё, что не Paid). В Payments встречаются дубли инвойса
 * («mushroom993-A3» и «@mushroom993-A3»): если хоть один дубль Paid — инвойс
 * оплачен, иначе считаем его один раз. Дубль = тот же заголовок и та же дата.
 */
export function unpaidAmount(payments: NotionPayment[]): number {
  const groups = new Map<string, NotionPayment[]>();
  for (const p of payments) {
    const key = `${p.title.trim().replace(/^@/, "").toLowerCase() || p.id}|${p.date ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  let sum = 0;
  for (const g of groups.values()) {
    if (g.some((p) => p.status === "Paid")) continue;
    sum += g[0].amount ?? 0;
  }
  return Math.round(sum * 100) / 100;
}

/** Выплаты партнёра: по нику в заголовке или по связи с его страницей в Partners. */
export async function listPayments(
  nick: string,
  partnerPageId: string | null,
  all?: NotionPayment[],
): Promise<NotionPayment[]> {
  const key = nickKey(nick);
  return (all ?? (await listAllPayments()))
    .filter((p) => nickKey(p.title) === key || (partnerPageId != null && p.partner_ids.includes(partnerPageId)))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.created_time.localeCompare(a.created_time));
}

/** Следующий заголовок инвойса: «@nick-A4» (максимальный номер по этой модели + 1). */
export function nextPaymentTitle(nick: string, notionModel: string, payments: NotionPayment[]): string {
  const letter = notionModel[0].toUpperCase();
  const re = new RegExp(`-${letter}(\\d+)$`, "i");
  const max = payments
    .filter((p) => p.model === notionModel)
    .reduce((m, p) => Math.max(m, Number(p.title.match(re)?.[1] ?? 0)), 0);
  return `@${handle(nick)}-${letter}${max + 1}`;
}

export async function createPartner(nick: string): Promise<NotionPartner> {
  const page = await call<Page>("POST", "/pages", {
    parent: { database_id: config().partnersDb },
    properties: { Partner: { title: [{ text: { content: `@${handle(nick)}` } }] } },
  });
  return toPartner(page);
}

export async function createPayment(input: {
  title: string;
  partnerPageId: string;
  model: string;
  date: string;
  fans: number;
  amount: number;
  status: string;
  notes?: string;
}): Promise<NotionPayment> {
  const page = await call<Page>("POST", "/pages", {
    parent: { database_id: config().paymentsDb },
    properties: {
      Payment: { title: [{ text: { content: input.title } }] },
      Partner: { relation: [{ id: input.partnerPageId }] },
      Model: { select: { name: input.model } },
      Date: { date: { start: input.date } },
      Fans: { number: input.fans },
      Amount: { number: input.amount },
      Status: { select: { name: input.status } },
      ...(input.notes ? { Notes: { rich_text: [{ text: { content: input.notes.slice(0, 2000) } }] } } : {}),
    },
  });
  return toPayment(page);
}

export async function updatePaymentStatus(pageId: string, status: string): Promise<NotionPayment> {
  const page = await call<Page>("PATCH", `/pages/${pageId}`, {
    properties: { Status: { select: { name: status } } },
  });
  return toPayment(page);
}
