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
import { startScheduler } from "./of/scheduler";

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

  const port = Number(process.env.PORT || 3001);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Couture Dashboard backend on :${port}`);

  startScheduler();
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

    const header = req.headers.authorization;
    const expected = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
    if (header === expected) return;

    reply
      .code(401)
      .header("WWW-Authenticate", 'Basic realm="Couture Dashboard"')
      .send({ error: "Unauthorized" });
  });
}
