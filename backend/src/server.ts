import "dotenv/config";
import Fastify, { FastifyInstance } from "fastify";
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
import { startScheduler } from "./of/scheduler";
import { startDailyCapture } from "./daily/scheduler";

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  registerBasicAuth(app);

  app.get("/api/health", async () => ({
    status: "ok",
    of_api_configured: !!process.env.ONLYFANSAPI_KEY,
  }));

  getDb();

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

  const port = Number(process.env.PORT || 3001);
  /* В проде за nginx ставь HOST=127.0.0.1 — тогда 3001 не торчит наружу. */
  const host = process.env.HOST || "0.0.0.0";
  await app.listen({ port, host });
  app.log.info(`Couture Dashboard backend on :${port}`);

  startScheduler();
  startDailyCapture();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function registerBasicAuth(app: FastifyInstance): void {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password || password === "changeme") return;

  app.addHook("onRequest", async (req, reply) => {
    /* Webhook должен оставаться публичным — OF API нужен прямой доступ.
       Подпись проверяется отдельно через WEBHOOK_SECRET. */
    if (req.url.startsWith("/api/webhooks/of")) return;
    /* Read-only выгрузка — защищена своим EXPORT_TOKEN (?key=...), не Basic-auth. */
    if (req.url.startsWith("/api/export")) return;

    const header = req.headers.authorization;
    const expected = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
    if (header === expected) return;

    reply
      .code(401)
      .header("WWW-Authenticate", 'Basic realm="Couture Dashboard"')
      .send({ error: "Unauthorized" });
  });
}
