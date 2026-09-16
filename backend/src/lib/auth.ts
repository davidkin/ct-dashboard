/**
 * Логин-окно дашборда: почта + пароль вместо общего Basic-auth пароля.
 *
 * Пароли — scrypt (встроен в node:crypto, без новых зависимостей). Сессии —
 * случайный токен в cookie, сама сессия хранится в таблице `sessions`
 * (миграция 003), поэтому рестарт бэкенда никого не разлогинивает.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "../db/index";

export type Role = "admin" | "affiliate_manager";

export interface SessionUser {
  id: number;
  email: string;
  role: Role;
}

const COOKIE_NAME = "ct_session";
const SESSION_DAYS = 30;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Создаёт сессию в БД и вешает cookie на ответ. */
export function issueSession(reply: FastifyReply, userId: number): void {
  const db = getDb();
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`).run(
    token,
    userId,
    expires.toISOString(),
  );
  const secure = process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "1";
  reply.header(
    "set-cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure ? "; Secure" : ""}`,
  );
}

export function clearSession(req: FastifyRequest, reply: FastifyReply): void {
  const token = readCookie(req, COOKIE_NAME);
  if (token) getDb().prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  reply.header("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Резолвит текущего пользователя из cookie. null, если сессии нет/истекла/деактивирован. */
export function currentUser(req: FastifyRequest): SessionUser | null {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT u.id, u.username AS email, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`,
    )
    .get(token) as { id: number; email: string; role: string; active: number } | undefined;
  if (!row || !row.active) return null;
  getDb().prepare(`UPDATE sessions SET last_seen_at = datetime('now') WHERE token = ?`).run(token);
  return { id: row.id, email: row.email, role: row.role as Role };
}

/** preHandler-хелпер: 403, если текущий пользователь не admin. Используй в конце write-роутов,
    которые по правилам David'а зарезервированы за админом (удаление ссылок, выплаты, вайт-лист). */
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user?.role === "admin") return true;
  reply.code(403).send({ error: "Доступно только администратору" });
  return false;
}
