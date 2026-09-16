/**
 * Логин-окно: одна форма на вход и на первую регистрацию сразу.
 *
 * Почта + пароль. Если почта в вайт-листе и аккаунта ещё нет — создаём его
 * этим же паролем (самообслуживание: слать письма с временным паролем
 * не через что — SMTP на сервере не настроен). Если аккаунт уже есть —
 * обычная проверка пароля. Если почты нет в вайт-листе — отказ.
 */
import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { currentUser, hashPassword, issueSession, clearSession, normalizeEmail, verifyPassword } from "../lib/auth";

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get("/api/auth/me", async (req) => {
    const user = currentUser(req);
    return { data: user };
  });

  app.post<{ Body: { email?: string; password?: string } }>("/api/auth/session", async (req, reply) => {
    const email = normalizeEmail(req.body?.email ?? "");
    const password = req.body?.password ?? "";
    if (!email || !password) {
      reply.code(400);
      return { error: "Укажи почту и пароль" };
    }
    if (password.length < 6) {
      reply.code(400);
      return { error: "Пароль должен быть не короче 6 символов" };
    }

    const existing = db.prepare(`SELECT id, password_hash, role, active FROM users WHERE username = ?`).get(email) as
      | { id: number; password_hash: string; role: string; active: number }
      | undefined;

    if (existing) {
      if (!existing.active) {
        reply.code(403);
        return { error: "Доступ отключён. Обратись к администратору." };
      }
      if (!verifyPassword(password, existing.password_hash)) {
        reply.code(401);
        return { error: "Неверный пароль" };
      }
      issueSession(reply, existing.id);
      return { data: { email, role: existing.role } };
    }

    /* Аккаунта нет — заводим, только если почта в вайт-листе. */
    const allowed = db.prepare(`SELECT role FROM allowed_emails WHERE email = ?`).get(email) as
      | { role: string }
      | undefined;
    if (!allowed) {
      reply.code(403);
      return { error: "Эта почта не в списке доступа. Попроси администратора добавить её." };
    }
    const info = db
      .prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`)
      .run(email, hashPassword(password), allowed.role);
    issueSession(reply, Number(info.lastInsertRowid));
    return { data: { email, role: allowed.role } };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    clearSession(req, reply);
    return { data: { ok: true } };
  });
}
