import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { creatorSlug, getAccountIdForCreator } from "../config/creators";
import { getAccount, listAccounts } from "../of/client";

/**
 * Кэш аватарок моделей: ключ = of_account_id.
 * TTL 30 мин — аватарки меняются редко, экономим OF API.
 */
const profileCache = new Map<string, { avatar: string | null; header: string | null; username: string | null; expires: number }>();
const PROFILE_TTL_MS = 30 * 60 * 1000;

async function getCachedProfiles(): Promise<typeof profileCache> {
  const now = Date.now();
  const allExpired = [...profileCache.values()].every((v) => v.expires < now);
  if (profileCache.size === 0 || allExpired) {
    try {
      const accounts = await listAccounts();
      profileCache.clear();
      for (const a of accounts) {
        profileCache.set(a.id, {
          avatar: a.onlyfans_user_data?.avatar ?? null,
          header: a.onlyfans_user_data?.header ?? null,
          username: a.onlyfans_username ?? null,
          expires: now + PROFILE_TTL_MS,
        });
      }
    } catch {
      /* Если OF API не отвечает — возвращаем старый кэш */
    }
  }
  return profileCache;
}

export async function registerCreatorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/creators", async () => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT
           l.creator AS name,
           COUNT(DISTINCT l.id)         AS links_count,
           COUNT(DISTINCT l.partner_id) AS partners_count,
           SUM(l.clicks_count)          AS clicks_total,
           SUM(l.subscribers_count)     AS subs_total,
           SUM(l.spenders_count)        AS spenders_total,
           SUM(l.revenue_total)         AS revenue_total,
           MAX(l.last_synced_at)        AS last_synced_at
         FROM links l
         GROUP BY l.creator
         ORDER BY l.creator`,
      )
      .all() as Array<{
        name: string;
        links_count: number;
        partners_count: number;
        clicks_total: number | null;
        subs_total: number | null;
        spenders_total: number | null;
        revenue_total: number | null;
        last_synced_at: string | null;
      }>;

    const profiles = process.env.ONLYFANSAPI_KEY ? await getCachedProfiles() : null;

    return {
      data: rows.map((r) => {
        const accountId = getAccountIdForCreator(r.name);
        const prof = accountId && profiles ? profiles.get(accountId) : null;
        return {
          ...r,
          slug: creatorSlug(r.name),
          account_id: accountId,
          configured: !!accountId,
          avatar: prof?.avatar ?? null,
          header: prof?.header ?? null,
          of_username: prof?.username ?? null,
        };
      }),
    };
  });

  /**
   * GET /api/creators/:slug
   * Карточка модели: агрегаты + профиль из OnlyFansAPI + топ партнёров.
   */
  app.get<{ Params: { slug: string } }>("/api/creators/:slug", async (req, reply) => {
    const db = getDb();
    const slug = req.params.slug;

    const allRows = db
      .prepare(`SELECT DISTINCT creator FROM links`)
      .all() as Array<{ creator: string }>;
    const creator = allRows.find((r) => creatorSlug(r.creator) === slug)?.creator;
    if (!creator) {
      reply.code(404);
      return { error: "Creator not found" };
    }
    const accountId = getAccountIdForCreator(creator);

    const aggregate = db
      .prepare(
        `SELECT
           COUNT(DISTINCT l.id) AS links_count,
           COUNT(DISTINCT l.partner_id) AS partners_count,
           SUM(l.clicks_count) AS clicks_total,
           SUM(l.subscribers_count) AS subs_total,
           SUM(l.spenders_count) AS spenders_total,
           SUM(l.revenue_total) AS revenue_total,
           MAX(l.last_synced_at) AS last_synced_at
         FROM links l WHERE l.creator = ?`,
      )
      .get(creator);

    const topPartners = db
      .prepare(
        `SELECT
           p.id, p.display_name, p.telegram, p.type, p.source,
           COUNT(l.id) AS links_count,
           SUM(l.clicks_count) AS clicks_total,
           SUM(l.subscribers_count) AS subs_total,
           SUM(l.revenue_total) AS revenue_total
         FROM partners p
         JOIN links l ON l.partner_id = p.id AND l.creator = ?
         GROUP BY p.id
         ORDER BY revenue_total DESC NULLS LAST, links_count DESC
         LIMIT 10`,
      )
      .all(creator);

    let profile: unknown = null;
    let profileError: string | null = null;
    if (accountId && process.env.ONLYFANSAPI_KEY) {
      try {
        const acc = await getAccount(accountId);
        if (acc) {
          profile = {
            username: acc.onlyfans_username,
            display_name: acc.display_name,
            is_authenticated: acc.is_authenticated,
            avatar: acc.onlyfans_user_data?.avatar ?? null,
            header: acc.onlyfans_user_data?.header ?? null,
            name: acc.onlyfans_user_data?.name ?? null,
            posts_count: acc.onlyfans_user_data?.postsCount ?? null,
            photos_count: acc.onlyfans_user_data?.photosCount ?? null,
            videos_count: acc.onlyfans_user_data?.videosCount ?? null,
            is_verified: acc.onlyfans_user_data?.isVerified ?? null,
            join_date: acc.onlyfans_user_data?.joinDate ?? null,
          };
        } else {
          profileError = "Account ID не найден среди подключённых в OnlyFansAPI";
        }
      } catch (err) {
        profileError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      data: {
        name: creator,
        slug,
        account_id: accountId,
        configured: !!accountId,
        aggregate,
        top_partners: topPartners,
        profile,
        profile_error: profileError,
      },
    };
  });
}
