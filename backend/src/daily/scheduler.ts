/**
 * Ночной планировщик дневного снэпшота.
 *
 * Раз в минуту проверяет локальное время (TRACKING_TZ). Когда оно достигает
 * DAILY_CAPTURE_AT (по умолчанию 23:59) и за сегодня снэпшот ещё не делался —
 * запускает captureDailyClicks({ runSync:true }).
 *
 * Подход «проверяем каждую минуту» вместо точного setTimeout — намеренно:
 * иммунен к переходам на летнее/зимнее время, не нужно считать смещение TZ.
 */
import { captureDailyClicks } from "./capture";
import { getDb } from "../db/index";
import { localHHMM, todayLocal, addDays, TRACKING_TZ } from "../lib/tz";

let timer: NodeJS.Timeout | null = null;
let lastCaptureDay: string | null = null;
const CAPTURE_AT = process.env.DAILY_CAPTURE_AT || "23:59";

/** Снэпшот за целевой день (вчера) уже есть в daily_om_stats? Идемпотентность: не
 *  даём рестарту после времени капчи сделать повторный (лишний) снэпшот. */
function alreadyCaptured(targetDay: string): boolean {
  try {
    const row = getDb()
      .prepare("SELECT 1 FROM daily_om_stats WHERE day = ? LIMIT 1")
      .get(targetDay);
    return !!row;
  } catch {
    return false;
  }
}

export function startDailyCapture(): void {
  if (timer) return;
  if (!process.env.ONLYMONSTER_TOKEN) {
    console.log("[daily] capture not started (no ONLYMONSTER_TOKEN)");
    return;
  }

  /* При старте: если сегодняшний снэпшот (за вчера) уже сделан — помечаем день
     как обработанный, чтобы рестарт после времени капчи не запустил повторный. */
  if (alreadyCaptured(addDays(todayLocal(), -1))) {
    lastCaptureDay = todayLocal();
  }

  const tick = async () => {
    try {
      const now = localHHMM();
      const today = todayLocal();
      /* Один раз за день (guard по lastCaptureDay + проверка БД от повторов при рестарте). */
      if (now >= CAPTURE_AT && lastCaptureDay !== today) {
        lastCaptureDay = today;
        const targetDay = addDays(today, -1);
        if (alreadyCaptured(targetDay)) {
          console.log(`[daily] snapshot for ${targetDay} already exists — skip (no duplicate)`);
          return;
        }
        console.log(`[daily] capturing clicks for ${targetDay} (finalized at ${now} ${TRACKING_TZ})`);
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
