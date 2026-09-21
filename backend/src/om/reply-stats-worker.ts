/**
 * Фоновый воркер конверсии "фан ответил на приветку" (первое сообщение фана
 * после нашего первого сообщения в чате). Считать это вживую на чтении отчёта
 * нельзя — OM отдаёт /chats/{id}/messages по 1 запросу/сек, а фанов тысячи.
 * Вместо этого воркер понемногу обходит фанов на фоне и складывает результат
 * в fan_reply_stats; API просто читает готовые строки.
 *
 * Кандидаты на проверку:
 *  - ещё не проверенные вообще (нет строки в fan_reply_stats);
 *  - проверенные, но НЕ ответившие и без ошибки — перепроверяем раз в сутки,
 *    пока подписке не исполнится 21 день (дальше шанс ответа пренебрежимо мал,
 *    останавливаем перепроверку, строка остаётся "не ответил" как финальная);
 *  - проверенные с 404 (чат ещё не создан в OM) — перепроверяем раз в сутки
 *    первые 14 дней, вдруг чат появится.
 *  - и то и то — только для подписок старше 3 дней (нужно время на ответ).
 */
import { getDb } from "../db/index";
import { activeCreatorNames, getOMAccountForCreator, getOMTokenForCreator } from "../config/creators";

const BASE = "https://omapi.onlymonster.ai";
const REQUEST_DELAY_MS = 1100;
const BATCH_SIZE = 45;
const TICK_MS = 90_000;

interface OMMessage {
  created_at: string;
  is_sent_by_me: boolean;
}

const internalAccountIdCache = new Map<string, string>();

async function resolveInternalAccountId(platformAccountId: string, token: string): Promise<string> {
  const cached = internalAccountIdCache.get(platformAccountId);
  if (cached) return cached;
  const res = await fetch(`${BASE}/api/v0/accounts?limit=1000`, {
    headers: { "x-om-auth-token": token, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`accounts lookup failed: ${res.status}`);
  const json = (await res.json()) as { accounts: Array<{ id: number; platform_account_id: string }> };
  const match = json.accounts.find((a) => a.platform_account_id === platformAccountId);
  if (!match) throw new Error(`no OM account for platform_account_id ${platformAccountId}`);
  const id = String(match.id);
  internalAccountIdCache.set(platformAccountId, id);
  return id;
}

async function fetchMessages(accountId: string, token: string, chatId: string): Promise<{ messages: OMMessage[]; notFound: boolean }> {
  const res = await fetch(`${BASE}/api/v0/accounts/${accountId}/chats/${chatId}/messages?order=asc&limit=100`, {
    headers: { "x-om-auth-token": token, Accept: "application/json" },
  });
  if (res.status === 404) return { messages: [], notFound: true };
  if (res.status === 429) throw new Error("429 rate limited");
  if (!res.ok) throw new Error(`${res.status}`);
  const json = (await res.json()) as { items?: OMMessage[] };
  return { messages: json.items ?? [], notFound: false };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface Candidate {
  link_id: number;
  creator: string;
  of_fan_id: string;
}

function selectCandidates(limit: number): Candidate[] {
  const db = getDb();
  const creators = activeCreatorNames();
  if (!creators.length) return [];
  const placeholders = creators.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT l.id AS link_id, l.creator, ls.of_fan_id
       FROM link_subscribers ls
       JOIN links l ON l.id = ls.link_id
       LEFT JOIN fan_reply_stats frs ON frs.link_id = ls.link_id AND frs.of_fan_id = ls.of_fan_id
       WHERE l.creator IN (${placeholders})
         AND ls.of_fan_id IS NOT NULL
         AND ls.om_subscribed_at <= datetime('now', '-3 days')
         AND (
           frs.of_fan_id IS NULL
           OR (frs.replied = 0 AND frs.om_error = 0 AND frs.checked_at <= datetime('now', '-1 day') AND ls.om_subscribed_at >= datetime('now', '-21 days'))
           OR (frs.om_error = 1 AND frs.checked_at <= datetime('now', '-1 day') AND ls.om_subscribed_at >= datetime('now', '-14 days'))
         )
       ORDER BY (frs.of_fan_id IS NULL) DESC, ls.om_subscribed_at DESC
       LIMIT ?`,
    )
    .all(...creators, limit) as Candidate[];
}

/** Ручной "Пересчитать": кандидаты партнёра в конкретном диапазоне дат подписки,
    без суточного троттлинга (кроме уже финально ответивших — это не трогаем,
    ответ не может "исчезнуть"). Считает и remaining, чтобы фронт мог дозапросить. */
function selectScopedCandidates(
  partnerId: number,
  from: string,
  to: string,
  limit: number,
): { candidates: Candidate[]; remaining: number } {
  const db = getDb();
  const creators = activeCreatorNames();
  if (!creators.length) return { candidates: [], remaining: 0 };
  const placeholders = creators.map(() => "?").join(",");
  const baseWhere = `
    l.creator IN (${placeholders})
    AND l.partner_id = ?
    AND ls.of_fan_id IS NOT NULL
    AND ls.om_subscribed_at >= ? AND ls.om_subscribed_at < ?
    AND ls.om_subscribed_at <= datetime('now', '-3 days')
    AND (frs.of_fan_id IS NULL OR frs.replied = 0)
  `;
  const params = [...creators, partnerId, from, `${to} 23:59:59.999`];
  const candidates = db
    .prepare(
      `SELECT l.id AS link_id, l.creator, ls.of_fan_id
       FROM link_subscribers ls
       JOIN links l ON l.id = ls.link_id
       LEFT JOIN fan_reply_stats frs ON frs.link_id = ls.link_id AND frs.of_fan_id = ls.of_fan_id
       WHERE ${baseWhere}
       ORDER BY ls.om_subscribed_at ASC
       LIMIT ?`,
    )
    .all(...params, limit) as Candidate[];
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM link_subscribers ls
       JOIN links l ON l.id = ls.link_id
       LEFT JOIN fan_reply_stats frs ON frs.link_id = ls.link_id AND frs.of_fan_id = ls.of_fan_id
       WHERE ${baseWhere}`,
    )
    .get(...params) as { n: number };
  return { candidates, remaining: Math.max(0, totalRow.n - candidates.length) };
}

const upsertStmt = () =>
  getDb().prepare(
    `INSERT INTO fan_reply_stats (link_id, of_fan_id, has_greeting, replied, reply_seconds, om_error, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (link_id, of_fan_id) DO UPDATE SET
       has_greeting = excluded.has_greeting,
       replied = excluded.replied,
       reply_seconds = excluded.reply_seconds,
       om_error = excluded.om_error,
       checked_at = excluded.checked_at`,
  );

async function checkOneFan(c: Candidate, upsert: ReturnType<typeof upsertStmt>): Promise<void> {
  const platformAccountId = getOMAccountForCreator(c.creator);
  const token = getOMTokenForCreator(c.creator);
  if (!platformAccountId || !token) return;
  try {
    const accountId = await resolveInternalAccountId(platformAccountId, token);
    const { messages, notFound } = await fetchMessages(accountId, token, c.of_fan_id);
    if (notFound) {
      upsert.run(c.link_id, c.of_fan_id, 0, 0, null, 1);
    } else {
      const greeting = messages.find((m) => m.is_sent_by_me);
      if (!greeting) {
        upsert.run(c.link_id, c.of_fan_id, 0, 0, null, 0);
      } else {
        const idx = messages.indexOf(greeting);
        const reply = messages.slice(idx + 1).find((m) => !m.is_sent_by_me);
        if (reply) {
          const dt = (new Date(reply.created_at).getTime() - new Date(greeting.created_at).getTime()) / 1000;
          upsert.run(c.link_id, c.of_fan_id, 1, 1, dt, 0);
        } else {
          upsert.run(c.link_id, c.of_fan_id, 1, 0, null, 0);
        }
      }
    }
  } catch (err) {
    console.error(`[reply-stats] fan=${c.of_fan_id} link=${c.link_id}:`, err instanceof Error ? err.message : err);
  }
}

let running = false;

export async function processReplyStatsBatch(limit = BATCH_SIZE): Promise<{ checked: number }> {
  if (running) return { checked: 0 };
  running = true;
  let checked = 0;
  try {
    const candidates = selectCandidates(limit);
    if (!candidates.length) return { checked: 0 };
    const upsert = upsertStmt();
    for (const c of candidates) {
      await checkOneFan(c, upsert);
      checked++;
      await sleep(REQUEST_DELAY_MS);
    }
  } finally {
    running = false;
  }
  return { checked };
}

/** Ручной "Пересчитать" на диапазон дат подписки конкретного партнёра — вызывается
    из UI-кнопки, не ждёт фоновую очередь. Один вызов ограничен по времени (nginx
    proxy_read_timeout 120s), поэтому лимит батча небольшой; фронт дозапрашивает,
    пока remaining>0. Отдельный флаг от фонового `running` — но фон всё равно
    ПРОПУСКАЕТ свой тик, пока это true (см. isScopedRunning в tick ниже): один
    OM-аккаунт, рейт-лимит общий, оба разом = сплошные 429 и впустую сожжённое
    время сна между ретраями. */
let scopedRunning = false;
export function isScopedRunning(): boolean {
  return scopedRunning;
}
/* Замерено на живом OM API: ~1.8с/фан (не 1.1с — сетевой round-trip сверху
   sleep), т.е. 80 фанов занимало 145с — больше чем nginx proxy_read_timeout
   120с, запрос обрывался хотя бэк доработал. 45 фанов ≈ 80с, запас есть. */
const SCOPED_BATCH_LIMIT = 45;

export async function processScopedReplyStatsBatch(
  partnerId: number,
  from: string,
  to: string,
): Promise<{ checked: number; remaining: number }> {
  if (scopedRunning) return { checked: 0, remaining: 0 };
  scopedRunning = true;
  let checked = 0;
  try {
    const { candidates, remaining } = selectScopedCandidates(partnerId, from, to, SCOPED_BATCH_LIMIT);
    if (!candidates.length) return { checked: 0, remaining };
    const upsert = upsertStmt();
    for (const c of candidates) {
      await checkOneFan(c, upsert);
      checked++;
      await sleep(REQUEST_DELAY_MS);
    }
    return { checked, remaining };
  } finally {
    scopedRunning = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startReplyStatsWorker(): void {
  if (timer) return;
  if (!process.env.ONLYMONSTER_TOKEN && !process.env.ONLYMONSTER_TOKEN_LILY) {
    console.log("[reply-stats] worker not started (no OM token)");
    return;
  }
  const tick = async () => {
    /* Ручной "Пересчитать" и фоновый воркер бьют в ОДИН и тот же OM-аккаунт —
       конкурируя, оба чаще ловят 429 и впустую жгут время на сон между
       ретраями. Приоритет ручному запуску: фон просто пропускает тик, пока
       кто-то жмёт "Пересчитать". */
    if (isScopedRunning()) return;
    try {
      const res = await processReplyStatsBatch();
      if (res.checked > 0) console.log(`[reply-stats] checked ${res.checked} fans`);
    } catch (err) {
      console.error("[reply-stats] tick error:", err);
    }
  };
  timer = setInterval(tick, TICK_MS);
  void tick();
  console.log(`[reply-stats] worker started (batch=${BATCH_SIZE}, every ${TICK_MS / 1000}s)`);
}

export function stopReplyStatsWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
