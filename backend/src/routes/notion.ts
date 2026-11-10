/**
 * Notion на странице партнёра: кошелёк из Partners, инвойсы из Payments
 * и создание нового инвойса. Партнёр сопоставляется по Telegram-нику.
 */
import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { requireAdmin } from "../lib/auth";
import {
  NOTION_MODEL,
  createPartner,
  createPayment,
  findPartner,
  isNotionConfigured,
  listAllPayments,
  listPayments,
  payoutTotals,
  unpaidAmount,
  nextPaymentTitle,
  updatePayment,
} from "../notion/client";

const STATUSES = ["Waiting", "Review", "HOLD", "Paid"];

export async function registerNotionRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();
  const partnerNick = (id: number) =>
    (db.prepare(`SELECT telegram FROM partners WHERE id = ?`).get(id) as { telegram: string | null } | undefined)
      ?.telegram ?? null;

  /** GET /api/partners/:id/notion — кошелёк, инвойсы и следующие номера по моделям. */
  app.get<{ Params: { id: string } }>("/api/partners/:id/notion", async (req, reply) => {
    if (!isNotionConfigured()) return { data: { configured: false } };
    const nick = partnerNick(Number(req.params.id));
    if (!nick) {
      const all = await listAllPayments().catch(() => []);
      return { data: { configured: true, nick: null, partner: null, payments: [], next: {}, unpaid: { partner: 0, all: unpaidAmount(all) } } };
    }
    try {
      const partner = await findPartner(nick);
      const all = await listAllPayments();
      const payments = await listPayments(nick, partner?.id ?? null, all);
      const next = Object.fromEntries(
        Object.entries(NOTION_MODEL).map(([model, nm]) => [model, nextPaymentTitle(nick, nm, payments)]),
      );
      const unpaid = { partner: unpaidAmount(payments), all: unpaidAmount(all) };
      const totals = { partner: payoutTotals(payments), all: payoutTotals(all) };
      return { data: { configured: true, nick, partner, payments, next, unpaid, totals } };
    } catch (e) {
      reply.code(502);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * POST /api/partners/:id/notion/payments — новый инвойс в Payments.
   * Body: { model: "Kimi"|"Nikki", date, fans, amount, status?, notes? }.
   * Если партнёра нет в Partners — создаём его там же (без кошелька).
   */
  app.post<{
    Params: { id: string };
    Body: { model?: string; date?: string; fans?: number; amount?: number; status?: string; notes?: string };
  }>("/api/partners/:id/notion/payments", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!isNotionConfigured()) {
      reply.code(400);
      return { error: "Notion не настроен" };
    }
    const nick = partnerNick(Number(req.params.id));
    const b = req.body ?? {};
    const notionModel = b.model ? NOTION_MODEL[b.model] : undefined;
    const fans = Number(b.fans);
    const amount = Number(b.amount);
    if (!nick || !notionModel || !b.date || !Number.isFinite(fans) || !Number.isFinite(amount)) {
      reply.code(400);
      return { error: "Нужны ник партнёра, model, date, fans, amount" };
    }
    try {
      const partner = (await findPartner(nick)) ?? (await createPartner(nick));
      const payments = await listPayments(nick, partner.id);
      const created = await createPayment({
        title: nextPaymentTitle(nick, notionModel, payments),
        partnerPageId: partner.id,
        model: notionModel,
        date: b.date,
        fans,
        amount: Math.round(amount * 100) / 100,
        status: STATUSES.includes(b.status ?? "") ? b.status! : "Waiting",
        notes: b.notes,
      });
      return { data: created };
    } catch (e) {
      reply.code(502);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** PATCH /api/notion/payments/:pageId — поправить инвойс: статус, фаны, сумма. */
  app.patch<{ Params: { pageId: string }; Body: { status?: string; fans?: number; amount?: number } }>(
    "/api/notion/payments/:pageId",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const b = req.body ?? {};
      const patch: { status?: string; fans?: number; amount?: number } = {};
      if (b.status !== undefined) patch.status = b.status;
      if (b.fans !== undefined) patch.fans = Number(b.fans);
      if (b.amount !== undefined) patch.amount = Math.round(Number(b.amount) * 100) / 100;
      const bad =
        (patch.status !== undefined && !STATUSES.includes(patch.status)) ||
        (patch.fans !== undefined && !Number.isFinite(patch.fans)) ||
        (patch.amount !== undefined && !Number.isFinite(patch.amount));
      if (!isNotionConfigured() || bad || !Object.keys(patch).length) {
        reply.code(400);
        return { error: `Нужно status (${STATUSES.join("/")}), fans или amount` };
      }
      try {
        return { data: await updatePayment(req.params.pageId, patch) };
      } catch (e) {
        reply.code(502);
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  );
}
