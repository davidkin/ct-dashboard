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
import { addDays } from "../lib/tz";
import { listAllPartners, listAllPayments, NotionPartner, NotionPayment, nickKey } from "./client";

export interface ReportItem {
  nick: string;
  wallet: string | null;
  chain: string | null;
  amount: number;
  fans: number;
  invoices: { title: string; model: string | null; amount: number; fans: number; status: string | null }[];
  text: string;
}

const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const money = (n: number) => `$${n.toFixed(2)}`;

export async function buildPayoutReport(weekStart: string, unpaidOnly: boolean) {
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

  const partnerOf = (p: NotionPayment): NotionPartner | undefined =>
    partners.find((x) => p.partner_ids.includes(x.id)) ?? partners.find((x) => nickKey(x.name) === nickKey(p.title));

  const groups = new Map<string, { partner?: NotionPartner; nick: string; list: NotionPayment[] }>();
  for (const p of byTitle.values()) {
    if (unpaidOnly && p.status === "Paid") continue;
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
    const text = [
      `Оплата трафика для @${g.nick}`,
      `Период: ${ddmm(weekStart)} - ${ddmm(weekEnd)}`,
      "",
      "",
      `Wallet: ${wallet ?? "НЕ УКАЗАН"}${chain ? `  (${chain})` : ""}`,
      `Amount: ${money(amount)}`,
      `Fans: ${fans}`,
    ].join("\n");
    return {
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
    };
  });
  /* $0 (revshare без выручки, пустые недели) платить нечего — в отчёт не берём */
  items.splice(0, items.length, ...items.filter((i) => i.amount > 0));
  items.sort((a, b) => b.amount - a.amount);
  return {
    week_start: weekStart,
    week_end: weekEnd,
    date,
    items,
    missing_wallet: items.filter((i) => !i.wallet).map((i) => i.nick),
    total: Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100,
  };
}
