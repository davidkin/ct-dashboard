import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";

export async function registerPartnerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/partners?creator=<name>
   * Возвращает партнёров с агрегатами.
   * Если указан creator — агрегаты считаются только по ссылкам этой модели,
   * партнёры без ссылок на эту модель скрываются.
   */
  app.get<{ Querystring: { creator?: string } }>("/api/partners", async (req) => {
    const db = getDb();
    const creator = req.query.creator?.trim();

    const sql = creator
      ? `SELECT
           p.id, p.display_name, p.glossary_name, p.telegram, p.type, p.source,
           p.monthly_fee, p.notes,
           COUNT(l.id)              AS links_count,
           SUM(l.clicks_count)      AS clicks_total,
           SUM(l.subscribers_count) AS subs_total,
           SUM(l.spenders_count)    AS spenders_total,
           SUM(l.revenue_total)     AS revenue_total,
           SUM(
             CASE
               WHEN l.revshare_pct IS NOT NULL AND COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                 THEN MAX(COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free), COALESCE(l.revenue_total, 0) * l.revshare_pct)
               WHEN l.revshare_pct IS NOT NULL
                 THEN COALESCE(l.revenue_total, 0) * l.revshare_pct
               WHEN COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                 THEN COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free)
               ELSE 0
             END
           ) AS payout_total,
           MAX(l.last_synced_at)    AS last_synced_at
         FROM partners p
         LEFT JOIN links l ON l.partner_id = p.id AND l.creator = ?
         GROUP BY p.id
         HAVING COUNT(l.id) > 0
         ORDER BY p.display_name COLLATE NOCASE`
      : `SELECT
           p.id, p.display_name, p.glossary_name, p.telegram, p.type, p.source,
           p.monthly_fee, p.notes,
           COUNT(l.id)              AS links_count,
           SUM(l.clicks_count)      AS clicks_total,
           SUM(l.subscribers_count) AS subs_total,
           SUM(l.spenders_count)    AS spenders_total,
           SUM(l.revenue_total)     AS revenue_total,
           SUM(
             CASE
               WHEN l.revshare_pct IS NOT NULL AND COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                 THEN MAX(COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free), COALESCE(l.revenue_total, 0) * l.revshare_pct)
               WHEN l.revshare_pct IS NOT NULL
                 THEN COALESCE(l.revenue_total, 0) * l.revshare_pct
               WHEN COALESCE(l.cpf_paid, l.cpf_free) IS NOT NULL
                 THEN COALESCE(l.subscribers_count, 0) * COALESCE(l.cpf_paid, l.cpf_free)
               ELSE 0
             END
           ) AS payout_total,
           MAX(l.last_synced_at)    AS last_synced_at
         FROM partners p
         LEFT JOIN links l ON l.partner_id = p.id
         GROUP BY p.id
         ORDER BY p.display_name COLLATE NOCASE`;

    const rows = creator
      ? db.prepare(sql).all(creator)
      : db.prepare(sql).all();
    return { data: rows };
  });

  /**
   * GET /api/partners/:id?creator=<name>
   * Карточка партнёра + его ссылки.
   * Если указан creator — отдаём только его ссылки для этой модели.
   */
  app.get<{ Params: { id: string }; Querystring: { creator?: string } }>(
    "/api/partners/:id",
    async (req, reply) => {
      const db = getDb();
      const id = Number(req.params.id);
      const creator = req.query.creator?.trim();

      const partner = db.prepare(`SELECT * FROM partners WHERE id = ?`).get(id);
      if (!partner) {
        reply.code(404);
        return { error: "Partner not found" };
      }
      const links = creator
        ? db
            .prepare(
              `SELECT * FROM links WHERE partner_id = ? AND creator = ? ORDER BY campaign_code`,
            )
            .all(id, creator)
        : db
            .prepare(
              `SELECT * FROM links WHERE partner_id = ? ORDER BY creator, campaign_code`,
            )
            .all(id);
      return { data: { partner, links } };
    },
  );

  /**
   * PATCH /api/partners/:id
   * Редактирование полей, которых нет в Glossary: monthly_fee, notes.
   * (type/source — read-only, источник истины = Glossary)
   */
  app.patch<{
    Params: { id: string };
    Body: {
      monthly_fee?: number | null;
      notes?: string | null;
    };
  }>("/api/partners/:id", async (req, reply) => {
    const db = getDb();
    const id = Number(req.params.id);
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of ["monthly_fee", "notes"] as const) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(req.body[key] ?? null);
      }
    }
    if (fields.length === 0) {
      reply.code(400);
      return { error: "No fields to update" };
    }
    fields.push(`updated_at = datetime('now')`);
    values.push(id);
    const result = db
      .prepare(`UPDATE partners SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    if (result.changes === 0) {
      reply.code(404);
      return { error: "Partner not found" };
    }
    const partner = db.prepare(`SELECT * FROM partners WHERE id = ?`).get(id);
    return { data: partner };
  });
}
