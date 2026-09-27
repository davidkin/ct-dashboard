/**
 * Массовая рассылка одинакового сообщения фанам через OM API.
 *
 * Отправка идёт с троттлингом (OM: 1 запрос/сек на chats/messages), поэтому
 * на пачку в тысячи фанов это долго — крутится фоновой джобой, а прогресс и
 * ошибки сразу пишутся в broadcast_jobs/broadcast_sends (не в памяти), чтобы
 * ничего не терялось при рестарте бэкенда.
 *
 * Полный список получателей тоже сохраняется (fan_ids_json), поэтому джоба
 * резюмируема: runBroadcast всегда вычисляет "кого ещё не отправляли" из базы,
 * а не из аргумента вызова. Это значит рестарт бэкенда не бросает рассылку
 * недоделанной навсегда — resumeInterruptedBroadcasts() на старте докручивает
 * всё, что осталось не finished_at.
 */
import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { getDb } from "../db/index";
import { requireAdmin } from "../lib/auth";
import { getOMAccountForCreator, isRetiredCreator } from "../config/creators";
import { listSubscriptions, resolveInternalAccountId, sendChatMessage } from "../om/client";

const SEND_DELAY_MS = 1100;

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
  stop_requested: number;
  fan_ids_json: string | null;
}

async function runBroadcast(jobId: string): Promise<void> {
  const db = getDb();
  const job = db.prepare(`SELECT * FROM broadcast_jobs WHERE id = ?`).get(jobId) as JobRow | undefined;
  if (!job || job.finished_at != null || !job.fan_ids_json) return;

  const platformAccountId = getOMAccountForCreator(job.creator);
  const insertSend = db.prepare(`INSERT INTO broadcast_sends (job_id, fan_id, ok, error) VALUES (?, ?, ?, ?)`);
  const bumpJob = db.prepare(`UPDATE broadcast_jobs SET sent = sent + ?, failed = failed + ? WHERE id = ?`);
  const stopCheck = db.prepare(`SELECT stop_requested FROM broadcast_jobs WHERE id = ?`);

  if (!platformAccountId) {
    insertSend.run(jobId, "(job)", 0, `модель «${job.creator}» больше не настроена`);
    db.prepare(`UPDATE broadcast_jobs SET failed = failed + 1, finished_at = datetime('now') WHERE id = ?`).run(jobId);
    return;
  }

  let internalAccountId: string;
  try {
    internalAccountId = await resolveInternalAccountId(platformAccountId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    insertSend.run(jobId, "(job)", 0, `не удалось определить аккаунт: ${msg}`);
    db.prepare(`UPDATE broadcast_jobs SET failed = failed + 1, finished_at = datetime('now') WHERE id = ?`).run(jobId);
    return;
  }

  const allFanIds = JSON.parse(job.fan_ids_json) as string[];
  const alreadyDone = new Set(
    (db.prepare(`SELECT fan_id FROM broadcast_sends WHERE job_id = ?`).all(jobId) as Array<{ fan_id: string }>).map(
      (r) => r.fan_id,
    ),
  );
  const remaining = allFanIds.filter((id) => !alreadyDone.has(id));

  for (const fanId of remaining) {
    const row = stopCheck.get(jobId) as { stop_requested: number } | undefined;
    if (row?.stop_requested) break;
    try {
      await sendChatMessage(internalAccountId, fanId, job.text, platformAccountId);
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

/**
 * Вызывается один раз при старте бэкенда: докручивает джобы, у которых
 * finished_at ещё NULL (процесс умер посреди рассылки — рестарт, краш).
 * Уважает stop_requested, если его успели проставить до рестарта.
 */
export async function resumeInterruptedBroadcasts(): Promise<void> {
  const db = getDb();
  const stuck = db
    .prepare(`SELECT id FROM broadcast_jobs WHERE finished_at IS NULL AND fan_ids_json IS NOT NULL`)
    .all() as Array<{ id: string }>;
  for (const { id } of stuck) {
    void runBroadcast(id);
  }
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
   * Пишет джобу + полный список получателей в базу, запускает фоновую
   * отправку, сразу отдаёт job_id.
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
        `INSERT INTO broadcast_jobs (id, creator, text, total, started_by, fan_ids_json) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(jobId, creator, text, fanIds.length, req.user?.email ?? null, JSON.stringify(fanIds));
      void runBroadcast(jobId);
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
        stopped: job.finished_at != null && job.stop_requested === 1,
        results: results.map((r) => ({ fan_id: r.fan_id, ok: !!r.ok, error: r.error ?? undefined })),
      },
    };
  });

  /** POST /api/broadcast/stop/:job_id — попросить джобу остановиться (сработает на следующей отправке). */
  app.post<{ Params: { job_id: string } }>("/api/broadcast/stop/:job_id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const db = getDb();
    const job = db.prepare(`SELECT id, finished_at FROM broadcast_jobs WHERE id = ?`).get(req.params.job_id) as
      | { id: string; finished_at: string | null }
      | undefined;
    if (!job) {
      reply.code(404);
      return { error: "Джоба не найдена" };
    }
    if (job.finished_at != null) {
      return { data: { already_done: true } };
    }
    db.prepare(`UPDATE broadcast_jobs SET stop_requested = 1 WHERE id = ?`).run(job.id);
    return { data: { stopping: true } };
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
        stopped: j.finished_at != null && j.stop_requested === 1,
      })),
    };
  });
}
