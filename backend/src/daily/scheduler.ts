/**
 * Ночной планировщик дневного снэпшота.
 *
 * Раз в минуту проверяет локальное время (TRACKING_TZ). Когда оно достигает
 * DAILY_CAPTURE_AT (по умолчанию 23:55) и за сегодня снэпшот ещё не делался —
 * запускает captureDailyClicks({ runSync:true }).
 *
 * Подход «проверяем каждую минуту» вместо точного setTimeout — намеренно:
 * иммунен к переходам на летнее/зимнее время, не нужно считать смещение TZ.
 */
import { captureDailyClicks } from "./capture";
import { localHHMM, todayLocal, TRACKING_TZ } from "../lib/tz";

let timer: NodeJS.Timeout | null = null;
let lastCaptureDay: string | null = null;
const CAPTURE_AT = process.env.DAILY_CAPTURE_AT || "23:55";

export function startDailyCapture(): void {
  if (timer) return;
  if (!process.env.ONLYMONSTER_TOKEN) {
    console.log("[daily] capture not started (no ONLYMONSTER_TOKEN)");
    return;
  }

  const tick = async () => {
    try {
      const now = localHHMM();
      const today = todayLocal();
      /* Окно 23:55–23:59: срабатывает один раз за день (guard по lastCaptureDay). */
      if (now >= CAPTURE_AT && lastCaptureDay !== today) {
        lastCaptureDay = today;
        console.log(`[daily] capturing clicks for ${today} (${TRACKING_TZ}) at ${now}`);
        const res = await captureDailyClicks({ runSync: true });
        console.log(
          `[daily] captured ${res.links_captured} links, unmatched=${res.links_unmatched}, ` +
            `om_synced=${res.om_synced}, ${res.duration_ms}ms` +
            (res.errors.length ? `, errors: ${res.errors.join("; ")}` : ""),
        );
      }
    } catch (err) {
      console.error("[daily] capture error:", err);
    }
  };

  timer = setInterval(tick, 60_000);
  console.log(`[daily] capture scheduled at ${CAPTURE_AT} ${TRACKING_TZ} (checks every 60s)`);
}

export function stopDailyCapture(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
