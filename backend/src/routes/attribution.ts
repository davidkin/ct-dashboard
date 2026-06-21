import { FastifyInstance } from "fastify";
import { getDb } from "../db/index";
import { linkReport, overview, partners } from "../fans/attribution";

/**
 * Attribution reports (read-only). Источник — fan-level ledger.
 * Payout считается authoritative в backend (fans/payout.ts), не во фронте.
 */
export async function registerAttributionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/attribution/overview", async () => {
    return { data: overview(getDb()) };
  });

  app.get("/api/attribution/partners", async () => {
    return { data: partners(getDb()) };
  });

  app.get<{ Params: { id: string } }>("/api/attribution/links/:id", async (req, reply) => {
    const report = linkReport(getDb(), Number(req.params.id));
    if (!report) {
      reply.code(404);
      return { error: "Link not found" };
    }
    return { data: report };
  });
}
