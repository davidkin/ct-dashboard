/**
 * Отчёт по оплате трафика за неделю — текстовые блоки для отправки партнёрам:
 *
 *   Оплата трафика для @nick
 *   Период: 02.11 - 08.11
 *
 *   Wallet: 0x...  (ERC-20)
 *   Amount: $1.80
 *   Fans: 2
 *
 * Берём инвойсы Notion с датой = понедельник после недели (обе модели), кошелёк —
 * из Notion Partners. Один перевод на партнёра: инвойсы Kimi и Nikki складываем.
 */
import { getDb } from "../db/index";
import { addDays } from "../lib/tz";
import { NOTION_MODEL, listAllPartners, listAllPayments, NotionPartner, NotionPayment, nickKey } from "./client";

/** Notion-модель (Anita) → модель дашборда (Kimi). */
const DASH_MODEL = Object.fromEntries(Object.entries(NOTION_MODEL).map(([d, n]) => [n, d]));

export interface ReportItem {
  nick: string;
  wallet: string | null;
  chain: string | null;
  amount: number;
  fans: number;
  invoices: { title: string; model: string | null; amount: number; fans: number; status: string | null }[];
  text: string;
  /** незакрытые (не Paid) инвойсы этого партнёра за прошлые недели */
  prev: { title: string; date: string | null; model: string | null; amount: number; fans: number; status: string | null }[];
  /** тот же текст, но с прошлыми долгами в Amount/Fans: «$18.80 ($15.00 + $1.80 + $2.00)»; null — долгов нет */
  text_with_prev: string | null;
  /** когда отчёт отправлен партнёру (null — не отправлен) */
  sent_at: string | null;
}

const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const money = (n: number) => `$${n.toFixed(2)}`;

export async function buildPayoutReport(weekStart: string, unpaidOnly: boolean, model: string | null = null) {
  const notionModel = model ? NOTION_MODEL[model] : null;
  const weekEnd = addDays(weekStart, 6);
  const date = addDays(weekStart, 7);
  const [payments, partners] = await Promise.all([listAllPayments(), listAllPartners()]);

  /* дубли инвойса (тот же заголовок и дата) — один, оплаченный в приоритете */
  const byTitle = new Map<string, NotionPayment>();
  for (const p of payments.filter((x) => x.date === date && x.title.trim())) {
    const k = p.title.trim().replace(/^@/, "").toLowerCase();
    const cur = byTitle.get(k);
    if (!cur || (p.status === "Paid" && cur.status !== "Paid")) byTitle.set(k, p);
  }

  /* Прошлые незакрытые инвойсы (дата раньше текущей, не Paid, с суммой) — для
     опции «приплюсовать долг» в отчёте. Дубли с Paid-близнецом закрыты. */
  const all = new Map<string, NotionPayment[]>();
  for (const p of payments.filter((x) => x.date && x.date < date && x.title.trim())) {
    const k = `${p.title.trim().replace(/^@/, "").toLowerCase()}|${p.date}`;
    all.set(k, [...(all.get(k) ?? []), p]);
  }
  const prevUnpaid = [...all.values()]
    .filter((g) => !g.some((p) => p.status === "Paid"))
    .map((g) => g[0])
    .filter((p) => (p.amount ?? 0) > 0 && (!notionModel || p.model === notionModel));

  const partnerOf = (p: NotionPayment): NotionPartner | undefined =>
    partners.find((x) => p.partner_ids.includes(x.id)) ?? partners.find((x) => nickKey(x.name) === nickKey(p.title));

  const groups = new Map<string, { partner?: NotionPartner; nick: string; list: NotionPayment[] }>();
  for (const p of byTitle.values()) {
    if (unpaidOnly && p.status === "Paid") continue;
    if (notionModel && p.model !== notionModel) continue;
    const np = partnerOf(p);
    const key = nickKey(np?.name ?? p.title);
    const g = groups.get(key) ?? { partner: np, nick: key, list: [] };
    g.list.push(p);
    groups.set(key, g);
  }

  const items: ReportItem[] = [...groups.values()].map((g) => {
    const amount = Math.round(g.list.reduce((s, p) => s + (p.amount ?? 0), 0) * 100) / 100;
    const fans = g.list.reduce((s, p) => s + (p.fans ?? 0), 0);
    const wallet = g.partner?.wallet?.trim() || null;
    const chain = g.partner?.chain ?? null;
    /* Модель: одна — просто имя; обе — с разбивкой суммы и фанов. */
    const byModel = new Map<string, { amount: number; fans: number }>();
    for (const p of g.list) {
      const m = DASH_MODEL[p.model ?? ""] ?? p.model ?? "?";
      const a = byModel.get(m) ?? { amount: 0, fans: 0 };
      a.amount += p.amount ?? 0;
      a.fans += p.fans ?? 0;
      byModel.set(m, a);
    }
    const modelLine =
      byModel.size === 1
        ? `Model: ${[...byModel.keys()][0]}`
        : `Model: ${[...byModel.entries()].map(([m, a]) => `${m} (${money(a.amount)}, ${a.fans} fans)`).join(" + ")}`;
    const prev = prevUnpaid
      .filter((p) => nickKey(partnerOf(p)?.name ?? p.title) === g.nick)
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    const render = (withPrev: boolean) => {
      const extra = withPrev ? prev : [];
      const total = Math.round((amount + extra.reduce((s2, p) => s2 + (p.amount ?? 0), 0)) * 100) / 100;
      const totalFans = fans + extra.reduce((s2, p) => s2 + (p.fans ?? 0), 0);
      const amountLine = extra.length
        ? `Amount: ${money(total)} (${[amount, ...extra.map((p) => p.amount ?? 0)].map(money).join(" + ")})`
        : `Amount: ${money(amount)}`;
      const fansLine = extra.length
        ? `Fans: ${totalFans} (${[fans, ...extra.map((p) => p.fans ?? 0)].join(" + ")})`
        : `Fans: ${fans}`;
      return [
        `Оплата трафика для @${g.nick}`,
        modelLine,
        `Период: ${ddmm(weekStart)} - ${ddmm(weekEnd)}`,
        "",
        "",
        `Wallet: ${wallet ?? "НЕ УКАЗАН"}${chain ? `  (${chain})` : ""}`,
        amountLine,
        fansLine,
      ].join("\n");
    };
    const text = render(false);
    const text_with_prev = prev.length ? render(true) : null;
    return {
      sent_at: null as string | null,
      nick: g.nick,
      wallet,
      chain,
      amount,
      fans,
      invoices: g.list.map((p) => ({
        title: p.title,
        model: p.model,
        amount: p.amount ?? 0,
        fans: p.fans ?? 0,
        status: p.status,
      })),
      text,
      text_with_prev,
      prev: prev.map((p) => ({
        title: p.title,
        date: p.date,
        model: p.model,
        amount: p.amount ?? 0,
        fans: p.fans ?? 0,
        status: p.status,
      })),
    };
  });
  /* $0 (revshare без выручки, пустые недели) платить нечего — в отчёт не берём */
  items.splice(0, items.length, ...items.filter((i) => i.amount > 0));
  items.sort((a, b) => b.amount - a.amount);
  const sent = getDb().prepare(`SELECT sent_at FROM payout_report_sent WHERE nick = ? AND week_start = ? AND model = ?`);
  for (const i of items) {
    i.sent_at = (sent.get(i.nick, weekStart, model ?? "") as { sent_at: string } | undefined)?.sent_at ?? null;
  }
  return {
    week_start: weekStart,
    week_end: weekEnd,
    date,
    items,
    missing_wallet: items.filter((i) => !i.wallet).map((i) => i.nick),
    total: Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100,
  };
}

export function setReportSent(nick: string, weekStart: string, sent: boolean, model: string | null = null): void {
  const db = getDb();
  const args = [nickKey(nick), weekStart, model ?? ""];
  if (sent) {
    db.prepare(`INSERT OR REPLACE INTO payout_report_sent (nick, week_start, model) VALUES (?, ?, ?)`).run(...args);
  } else {
    db.prepare(`DELETE FROM payout_report_sent WHERE nick = ? AND week_start = ? AND model = ?`).run(...args);
  }
}
