/**
 * Управление доступом: вайт-лист почт и список заведённых пользователей.
 * Всё здесь — только для роли admin (проверяется в server.ts на уровне
 * сессии, плюс requireAdmin внутри write-эндпоинтов на всякий случай).
 */
import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { normalizeEmail, requireAdmin, type Role } from "../lib/auth";

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.get("/api/admin/whitelist", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = db
      .prepare(
        `SELECT a.email, a.role, a.can_see_external, a.can_see_inhouse, a.added_by, a.created_at,
                u.id IS NOT NULL AS registered, u.active AS user_active
         FROM allowed_emails a LEFT JOIN users u ON u.username = a.email
         ORDER BY a.created_at DESC`,
      )
      .all();
    return { data: rows };
  });

  app.post<{ Body: { email?: string; role?: Role; can_see_external?: boolean; can_see_inhouse?: boolean } }>(
    "/api/admin/whitelist",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const email = normalizeEmail(req.body?.email ?? "");
      const role = req.body?.role;
      const canSeeExternal = req.body?.can_see_external ?? true;
      const canSeeInhouse = req.body?.can_see_inhouse ?? true;
      if (!email || (role !== "admin" && role !== "affiliate_manager")) {
        reply.code(400);
        return { error: "Укажи почту и роль (admin / affiliate_manager)" };
      }
      const user = req.user!;
      db.prepare(
        `INSERT INTO allowed_emails (email, role, can_see_external, can_see_inhouse, added_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           role = excluded.role,
           can_see_external = excluded.can_see_external,
           can_see_inhouse = excluded.can_see_inhouse`,
      ).run(email, role, canSeeExternal ? 1 : 0, canSeeInhouse ? 1 : 0, user.email);
      /* Аккаунт уже мог быть создан раньше (self-serve при первом входе) —
         allowed_emails и users иначе разъезжаются: правка в "Доступ" молча
         не подействует, пока юзер не пересоздаст аккаунт (а он не пересоздаст,
         регистрация одноразовая). Синкаем сразу, чтобы правки применялись живым
         пользователям, а не только будущим регистрациям. */
      db.prepare(
        `UPDATE users SET role = ?, can_see_external = ?, can_see_inhouse = ?, updated_at = datetime('now')
         WHERE username = ?`,
      ).run(role, canSeeExternal ? 1 : 0, canSeeInhouse ? 1 : 0, email);
      return { data: { email, role, can_see_external: canSeeExternal, can_see_inhouse: canSeeInhouse } };
    },
  );

  app.delete<{ Params: { email: string } }>("/api/admin/whitelist/:email", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const email = normalizeEmail(req.params.email);
    db.prepare(`DELETE FROM allowed_emails WHERE email = ?`).run(email);
    return { data: { deleted: email } };
  });

  app.patch<{ Params: { id: string }; Body: { active?: boolean } }>(
    "/api/admin/users/:id",
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const id = Number(req.params.id);
      if (req.body?.active === undefined) {
        reply.code(400);
        return { error: "Укажи active" };
      }
      db.prepare(`UPDATE users SET active = ?, updated_at = datetime('now') WHERE id = ?`).run(
        req.body.active ? 1 : 0,
        id,
      );
      return { data: { id, active: !!req.body.active } };
    },
  );
}
