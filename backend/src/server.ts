import "dotenv/config";
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { getDb } from "./db/index";
import { registerActivityRoutes } from "./routes/activity";
import { registerAttributionRoutes } from "./routes/attribution";
import { registerCreatorRoutes } from "./routes/creators";
import { registerFanRoutes } from "./routes/fans";
import { registerFinanceRoutes } from "./routes/finances";
import { registerLinksRoutes } from "./routes/links";
import { registerPartnerRoutes } from "./routes/partners";
import { registerSyncRoutes } from "./routes/sync";
import { registerTrendsRoutes } from "./routes/trends";
import { registerWebhookRoutes } from "./routes/webhooks";
import { registerDailyRoutes } from "./routes/daily";
import { registerExportRoutes } from "./routes/export";
import { registerManageRoutes } from "./routes/manage";
import { registerGlossaryRoutes } from "./routes/glossary";
import { registerAuthRoutes } from "./routes/auth";
import { registerAdminRoutes } from "./routes/admin";
import { registerCabinetRoutes } from "./routes/cabinet";
import { registerReplyStatsRoutes } from "./routes/reply-stats";
import { currentUser, type SessionUser } from "./lib/auth";
import { startScheduler } from "./of/scheduler";
import { startDailyCapture } from "./daily/scheduler";
import { startReplyStatsWorker } from "./om/reply-stats-worker";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true, credentials: true });
  registerSessionAuth(app);

  app.get("/api/health", async () => ({
    status: "ok",
    of_api_configured: !!process.env.ONLYFANSAPI_KEY,
  }));

  getDb();

  await registerAuthRoutes(app);
  await registerCreatorRoutes(app);
  await registerPartnerRoutes(app);
  await registerLinksRoutes(app);
  await registerSyncRoutes(app);
  await registerActivityRoutes(app);
  await registerTrendsRoutes(app);
  await registerFinanceRoutes(app);
  await registerWebhookRoutes(app);
  await registerAttributionRoutes(app);
  await registerFanRoutes(app);
  await registerDailyRoutes(app);
  await registerExportRoutes(app);
  await registerManageRoutes(app);
  await registerGlossaryRoutes(app);
  await registerAdminRoutes(app);
  await registerCabinetRoutes(app);
  await registerReplyStatsRoutes(app);

  const port = Number(process.env.PORT || 3001);
  /* В проде за nginx ставь HOST=127.0.0.1 — тогда 3001 не торчит наружу. */
  const host = process.env.HOST || "0.0.0.0";
  await app.listen({ port, host });
  app.log.info(`Couture Dashboard backend on :${port}`);

  startScheduler();
  startDailyCapture();
  startReplyStatsWorker();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Гейт по сессии (cookie), пришёл на смену общему Basic-auth паролю: у каждого
 * оператора теперь своя почта/пароль и роль (admin / affiliate_manager).
 *
 * Публичные пути (без сессии):
 *  - /api/webhooks/of — подпись проверяется отдельно через WEBHOOK_SECRET
 *  - /api/export*     — свой EXPORT_TOKEN в query
 *  - /api/cabinet/*   — личный кабинет траффера, токен в URL и есть авторизация
 *  - /api/auth/*      — логин-окно: сюда и приходят без сессии
 *  - /api/health
 */
function registerSessionAuth(app: FastifyInstance): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (
      req.url.startsWith("/api/webhooks/of") ||
      req.url.startsWith("/api/export") ||
      req.url.startsWith("/api/cabinet") ||
      req.url.startsWith("/api/auth") ||
      req.url.startsWith("/api/health")
    ) {
      return;
    }
    if (!req.url.startsWith("/api/")) return;

    const user = currentUser(req);
    if (!user) {
      reply.code(401).send({ error: "Не авторизован" });
      return;
    }
    req.user = user;
  });
}
