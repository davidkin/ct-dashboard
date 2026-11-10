/**
 * Массовые инвойсы в Notion за неделю: по каждому партнёру модели берём фанов и
 * выплату из того же отчёта, что и таблица трафика (combined), и готовим инвойс
 * «@nick-A<n>» с датой = понедельник после недели.
 *
 * Партнёры — только из глоссария (у кого есть ссылки этой модели в отчёте).
 * Если у партнёра уже есть инвойс этой модели с этой датой — пропускаем, так что
 * повторный запуск дублей не плодит.
 */
import { getDb } from "../db/index";
import { buildDailyReport } from "../daily/report";
import { addDays } from "../lib/tz";
import {
  NOTION_MODEL,
  NotionPartner,
  NotionPayment,
  createPartner,
  createPayment,
  findPartner,
  listAllPartners,
  listAllPayments,
  listPayments,
  nextPaymentTitle,
} from "./client";

export interface BulkRow {
  partner_id: number;
  name: string;
  telegram: string | null;
  fans: number;
  amount: number;
  /** ready — можно создавать; exists — инвойс на эту дату уже есть; no_nick — нет ника */
  state: "ready" | "exists" | "no_nick";
  title: string | null;
  existing_title?: string;
  in_notion_partners: boolean;
}

export interface BulkPlan {
  model: string;
  notion_model: string;
  week_start: string;
  week_end: string;
  date: string;
  rows: BulkRow[];
}

export async function planBulk(model: string, weekStart: string): Promise<BulkPlan> {
  const notionModel = NOTION_MODEL[model];
  if (!notionModel) throw new Error(`Нет Notion-модели для ${model}`);
  const weekEnd = addDays(weekStart, 6);
  const date = addDays(weekStart, 7);

  const report = buildDailyReport({
    creator: null,
    model,
    from: weekStart,
    to: weekEnd,
    partner: null,
    includeEmpty: true,
    source: "combined",
  });
  const linkPartner = new Map(report.campaigns.map((c) => [String(c.link_id), c.partner_id]));
  const agg = new Map<number, { fans: number; amount: number }>();
  for (const r of report.rows) {
    for (const [linkId, cell] of Object.entries(r.cells)) {
      const pid = linkPartner.get(linkId);
      if (pid == null) continue;
      const a = agg.get(pid) ?? { fans: 0, amount: 0 };
      a.fans += cell.subs;
      a.amount += cell.payout;
      agg.set(pid, a);
    }
  }

  const db = getDb();
  const meta = db.prepare(`SELECT display_name, telegram, COALESCE(archived,0) AS archived FROM partners WHERE id = ?`);
  const [payments, nPartners] = await Promise.all([listAllPayments(), listAllPartners()]);

  const rows: BulkRow[] = [];
  for (const [pid, a] of agg) {
    if (a.fans === 0 && a.amount === 0) continue;
    const p = meta.get(pid) as { display_name: string; telegram: string | null; archived: number } | undefined;
    if (!p || p.archived) continue;
    const amount = Math.round(a.amount * 100) / 100;
    const base = { partner_id: pid, name: p.display_name, telegram: p.telegram, fans: a.fans, amount };
    if (!p.telegram) {
      rows.push({ ...base, state: "no_nick", title: null, in_notion_partners: false });
      continue;
    }
    const np = await findPartner(p.telegram, nPartners);
    const mine = await listPayments(p.telegram, np?.id ?? null, payments);
    const dup = mine.find((x) => x.model === notionModel && x.date === date);
    rows.push({
      ...base,
      state: dup ? "exists" : "ready",
      title: dup ? dup.title : nextPaymentTitle(p.telegram, notionModel, mine),
      existing_title: dup?.title,
      in_notion_partners: !!np,
    });
  }
  rows.sort((x, y) => y.amount - x.amount || y.fans - x.fans);
  return { model, notion_model: notionModel, week_start: weekStart, week_end: weekEnd, date, rows };
}

/** Создать инвойсы для выбранных партнёров (пересчитываем план, чтобы цифры и номера были свежими). */
export async function applyBulk(
  model: string,
  weekStart: string,
  partnerIds: number[],
  status: string,
): Promise<{ created: NotionPayment[]; skipped: { partner_id: number; reason: string }[] }> {
  const plan = await planBulk(model, weekStart);
  const want = new Set(partnerIds);
  const nPartners: NotionPartner[] = await listAllPartners();
  const created: NotionPayment[] = [];
  const skipped: { partner_id: number; reason: string }[] = [];
  for (const r of plan.rows) {
    if (!want.has(r.partner_id)) continue;
    if (r.state !== "ready" || !r.telegram || !r.title) {
      skipped.push({ partner_id: r.partner_id, reason: r.state });
      continue;
    }
    try {
      let np = await findPartner(r.telegram, nPartners);
      if (!np) {
        np = await createPartner(r.telegram);
        nPartners.push(np);
      }
      created.push(
        await createPayment({
          title: r.title,
          partnerPageId: np.id,
          model: plan.notion_model,
          date: plan.date,
          fans: r.fans,
          amount: r.amount,
          status,
          notes: `Дашборд: ${plan.week_start} – ${plan.week_end}`,
        }),
      );
    } catch (e) {
      skipped.push({ partner_id: r.partner_id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { created, skipped };
}
