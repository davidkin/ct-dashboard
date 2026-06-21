import { syncAllCreators } from "./sync";

let timer: NodeJS.Timeout | null = null;
// 5 часов — экономим OF API кредиты + sync можно вручную в любой момент.
const INTERVAL_MS = 5 * 60 * 60 * 1000;

export function startScheduler(): void {
  if (!process.env.ONLYFANSAPI_KEY) {
    console.log("OF scheduler not started (no API key)");
    return;
  }
  if (timer) return;
  const run = async () => {
    try {
      const results = await syncAllCreators();
      const summary = results
        .map((r) => `${r.creator}: ${r.matched}/${r.fetched} matched in ${r.durationMs}ms`)
        .join("; ");
      console.log(`[scheduler] ${summary || "no models synced"}`);
    } catch (err) {
      console.error("[scheduler] error:", err);
    }
  };
  timer = setInterval(run, INTERVAL_MS);
  console.log(`OF scheduler started (every ${INTERVAL_MS / 1000 / 3600}h, manual sync via POST /api/sync)`);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
