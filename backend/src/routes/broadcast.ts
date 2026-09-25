/**
 * Массовая рассылка одинакового сообщения фанам через OM API.
 *
 * Отправка идёт с троттлингом (OM: 1 запрос/сек на chats/messages), поэтому
 * на пачку в тысячи фанов это долго — крутится фоновой джобой в памяти,
 * фронт опрашивает прогресс. Джоба не переживает рестарт бэкенда (это ок,
 * рассылка одноразовая, не daily-джоба).
 */
import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { requireAdmin } from "../lib/auth";
import { getOMAccountForCreator, isRetiredCreator } from "../config/creators";
import { listSubscriptions, resolveInternalAccountId, sendChatMessage } from "../om/client";

const SEND_DELAY_MS = 1100;

interface BroadcastJob {
  id: string;
  creator: string;
  total: number;
  sent: number;
  failed: number;
  done: boolean;
  results: Array<{ fan_id: string; ok: boolean; error?: string }>;
  started_at: string;
}

const jobs = new Map<string, BroadcastJob>();

async function runBroadcast(job: BroadcastJob, fanIds: string[], text: string, platformAccountId: string): Promise<void> {
  const internalAccountId = await resolveInternalAccountId(platformAccountId);
  for (const fanId of fanIds) {
    try {
      await sendChatMessage(internalAccountId, fanId, text, platformAccountId);
      job.sent++;
      job.results.push({ fan_id: fanId, ok: true });
    } catch (err) {
      job.failed++;
      job.results.push({ fan_id: fanId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
  }
  job.done = true;
}

export async function registerBroadcastRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/broadcast/fans?creator=Lily Free — список подписчиков аккаунта
   * (id + дата подписки + цена), для справки/выбора получателей.
   */
  app.get<{ Querystring: { creator?: string } }>("/api/broadcast/fans", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const creator = (req.query.creator ?? "").trim();
    if (!creator || isRetiredCreator(creator)) {
      reply.code(400);
      return { error: "Укажи активную модель (creator)" };
    }
    const platformAccountId = getOMAccountForCreator(creator);
    if (!platformAccountId) {
      reply.code(400);
      return { error: `Модель «${creator}» не настроена` };
    }
    const subs = await listSubscriptions(platformAccountId);
    /* Один фан может встречаться несколько раз (resubscribe) — оставляем самую позднюю. */
    const byFan = new Map<string, { fan_id: string; subscribed_at: string; price_gross: number }>();
    for (const s of subs) {
      const prev = byFan.get(s.fan.id);
      if (!prev || s.subscribed_at > prev.subscribed_at) {
        byFan.set(s.fan.id, { fan_id: s.fan.id, subscribed_at: s.subscribed_at, price_gross: s.price_gross });
      }
    }
    const fans = [...byFan.values()].sort((a, b) => (a.subscribed_at < b.subscribed_at ? 1 : -1));
    return { data: { creator, count: fans.length, fans } };
  });

  /**
   * POST /api/broadcast/start — body { creator, fan_ids: string[], text }.
   * Запускает фоновую отправку, сразу отдаёт job_id.
   */
  app.post<{ Body: { creator?: string; fan_ids?: string[]; text?: string } }>(
    "/api/broadcast/start",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const creator = (req.body?.creator ?? "").trim();
      const fanIds = (req.body?.fan_ids ?? []).map((s) => String(s).trim()).filter(Boolean);
      const text = (req.body?.text ?? "").trim();
      if (!creator || isRetiredCreator(creator)) {
        reply.code(400);
        return { error: "Укажи активную модель (creator)" };
      }
      const platformAccountId = getOMAccountForCreator(creator);
      if (!platformAccountId) {
        reply.code(400);
        return { error: `Модель «${creator}» не настроена` };
      }
      if (fanIds.length === 0) {
        reply.code(400);
        return { error: "Не выбрано ни одного фана" };
      }
      if (!text) {
        reply.code(400);
        return { error: "Пустой текст сообщения" };
      }
      const job: BroadcastJob = {
        id: randomUUID(),
        creator,
        total: fanIds.length,
        sent: 0,
        failed: 0,
        done: false,
        results: [],
        started_at: new Date().toISOString(),
      };
      jobs.set(job.id, job);
      void runBroadcast(job, fanIds, text, platformAccountId).catch((err) => {
        job.done = true;
        job.results.push({ fan_id: "(job)", ok: false, error: err instanceof Error ? err.message : String(err) });
      });
      return { data: { job_id: job.id, total: job.total } };
    },
  );

  /** GET /api/broadcast/status/:job_id — прогресс рассылки. */
  app.get<{ Params: { job_id: string } }>("/api/broadcast/status/:job_id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const job = jobs.get(req.params.job_id);
    if (!job) {
      reply.code(404);
      return { error: "Джоба не найдена (рестарт бэкенда сбрасывает список)" };
    }
    return {
      data: {
        job_id: job.id,
        creator: job.creator,
        total: job.total,
        sent: job.sent,
        failed: job.failed,
        done: job.done,
        results: job.results,
      },
    };
  });
}
