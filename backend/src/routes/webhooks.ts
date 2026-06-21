import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { getDb } from "../db/index";

/**
 * Webhook-приёмник для OnlyFansAPI.
 *
 * Регистрация на стороне OF: их Console → Webhooks → endpoint URL = публичный URL этого роута.
 * Опционально: signing secret → попадает в заголовок `X-Signature`, мы проверяем HMAC-SHA256.
 *
 * Логика:
 *   1. Проверяем подпись (если задана `WEBHOOK_SECRET`)
 *   2. Записываем сырое событие в `webhook_events` (для аудита и переигрывания)
 *   3. Возвращаем 200 быстро — OF любит таймауты 15 сек
 *
 * Обработка событий (применение к БД) выносится в отдельный worker
 * через флаг `status='pending'` — пока что просто пишем в журнал.
 */
export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: unknown }>("/api/webhooks/of", async (req, reply) => {
    const secret = process.env.WEBHOOK_SECRET;
    const rawBody = JSON.stringify(req.body ?? {});

    if (secret) {
      const sig = req.headers["x-signature"] as string | undefined;
      if (!sig) { reply.code(401); return { error: "Missing signature" }; }
      const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      if (!safeEqual(sig, expected)) { reply.code(401); return { error: "Bad signature" }; }
    }

    const body = (req.body ?? {}) as { event_type?: string; type?: string; account_id?: string };
    const eventType = body.event_type ?? body.type ?? "unknown";
    const accountId = body.account_id ?? null;

    const db = getDb();
    db.prepare(
      `INSERT INTO webhook_events (event_type, of_account_id, payload_json, status)
       VALUES (?, ?, ?, 'pending')`,
    ).run(eventType, accountId, rawBody);

    return { ok: true };
  });

  /** GET /api/webhooks/events — последние события (для Activity Feed) */
  app.get<{ Querystring: { limit?: string } }>("/api/webhooks/events", async (req) => {
    const db = getDb();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const rows = db
      .prepare(`SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?`)
      .all(limit);
    return { data: rows };
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
