/**
 * Массовая рассылка одинакового сообщения фанам через OM API.
 *
 * Отправка идёт с троттлингом (OM: 1 запрос/сек на chats/messages), поэтому
 * на пачку в тысячи фанов это долго — крутится фоновой джобой, а прогресс и
 * ошибки сразу пишутся в broadcast_jobs/broadcast_sends (не в памяти), чтобы
 * ничего не терялось при рестарте бэкенда и было видно в истории на странице.
 */
import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { getDb } from "../db/index";
import { requireAdmin } from "../lib/auth";
import { getOMAccountForCreator, isRetiredCreator } from "../config/creators";
import { listSubscriptions, resolveInternalAccountId, sendChatMessage } from "../om/client";

const SEND_DELAY_MS = 1100;

async function runBroadcast(jobId: string, fanIds: string[], text: string, platformAccountId: string): Promise<void> {
  const db = getDb();
  const insertSend = db.prepare(
    `INSERT INTO broadcast_sends (job_id, fan_id, ok, error) VALUES (?, ?, ?, ?)`,
  );
  const bumpJob = db.prepare(
    `UPDATE broadcast_jobs SET sent = sent + ?, failed = failed + ? WHERE id = ?`,
  );
  let internalAccountId: string;
  try {
    internalAccountId = await resolveInternalAccountId(platformAccountId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    insertSend.run(jobId, "(job)", 0, `не удалось определить аккаунт: ${msg}`);
    db.prepare(`UPDATE broadcast_jobs SET failed = failed + 1, finished_at = datetime('now') WHERE id = ?`).run(jobId);
    return;
  }
  for (const fanId of fanIds) {
    try {
      await sendChatMessage(internalAccountId, fanId, text, platformAccountId);
      insertSend.run(jobId, fanId, 1, null);
      bumpJob.run(1, 0, jobId);
    } catch (err) {
      insertSend.run(jobId, fanId, 0, err instanceof Error ? err.message : String(err));
      bumpJob.run(0, 1, jobId);
    }
    await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
  }
  db.prepare(`UPDATE broadcast_jobs SET finished_at = datetime('now') WHERE id = ?`).run(jobId);
}

interface JobRow {
  id: string;
  creator: string;
  text: string;
  total: number;
  sent: number;
  failed: number;
  started_by: string | null;
  started_at: string;
  finished_at: string | null;
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
   * Пишет джобу в broadcast_jobs, запускает фоновую отправку, сразу отдаёт job_id.
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
      const db = getDb();
      const jobId = randomUUID();
      db.prepare(
        `INSERT INTO broadcast_jobs (id, creator, text, total, started_by) VALUES (?, ?, ?, ?, ?)`,
      ).run(jobId, creator, text, fanIds.length, req.user?.email ?? null);
      void runBroadcast(jobId, fanIds, text, platformAccountId);
      return { data: { job_id: jobId, total: fanIds.length } };
    },
  );

  /** GET /api/broadcast/status/:job_id — прогресс рассылки, из базы. */
  app.get<{ Params: { job_id: string } }>("/api/broadcast/status/:job_id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const db = getDb();
    const job = db.prepare(`SELECT * FROM broadcast_jobs WHERE id = ?`).get(req.params.job_id) as JobRow | undefined;
    if (!job) {
      reply.code(404);
      return { error: "Джоба не найдена" };
    }
    const results = db
      .prepare(`SELECT fan_id, ok, error FROM broadcast_sends WHERE job_id = ? ORDER BY id`)
      .all(job.id) as Array<{ fan_id: string; ok: number; error: string | null }>;
    return {
      data: {
        job_id: job.id,
        creator: job.creator,
        total: job.total,
        sent: job.sent,
        failed: job.failed,
        done: job.finished_at != null,
        results: results.map((r) => ({ fan_id: r.fan_id, ok: !!r.ok, error: r.error ?? undefined })),
      },
    };
  });

  /** GET /api/broadcast/jobs — история рассылок, для лога ошибок. */
  app.get("/api/broadcast/jobs", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const db = getDb();
    const jobs = db
      .prepare(`SELECT * FROM broadcast_jobs ORDER BY started_at DESC LIMIT 100`)
      .all() as JobRow[];
    return {
      data: jobs.map((j) => ({
        job_id: j.id,
        creator: j.creator,
        text: j.text,
        total: j.total,
        sent: j.sent,
        failed: j.failed,
        started_by: j.started_by,
        started_at: j.started_at,
        finished_at: j.finished_at,
        done: j.finished_at != null,
      })),
    };
  });
}
