/**
 * Таймзона для границы суток в дневном трекинге.
 *
 * om_subscribed_at приходит в UTC; «день» и время ночного джоба (23:55) считаем
 * по этой зоне. Меняется через TRACKING_TZ в .env без правок кода.
 */
export const TRACKING_TZ = process.env.TRACKING_TZ || "Europe/Kyiv";

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TRACKING_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TRACKING_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** YYYY-MM-DD в TRACKING_TZ для момента (Date | ISO-строка). "" если невалидно. */
export function localDay(input: Date | string): string {
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "";
  return dateFmt.format(d); // en-CA → 2026-06-15
}

/** HH:mm в TRACKING_TZ (для сравнения с временем запуска джоба). */
export function localHHMM(input: Date = new Date()): string {
  return timeFmt.format(input);
}

/** Сегодняшняя дата (YYYY-MM-DD) в TRACKING_TZ. */
export function todayLocal(): string {
  return localDay(new Date());
}

/** Сдвиг YYYY-MM-DD на delta дней (календарно, без TZ-сюрпризов). */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** Смещение зоны от UTC в мс для момента (положительное = зона впереди UTC). */
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = dtf.formatToParts(date).reduce<Record<string, string>>((a, x) => {
    a[x.type] = x.value;
    return a;
  }, {});
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour === "24" ? "0" : p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUTC - date.getTime();
}

/** ISO (UTC) следующего наступления времени HH:mm в TRACKING_TZ (для таймера до снепшота). */
export function nextCaptureAt(captureTime: string): string {
  const [hh, mm] = captureTime.split(":").map(Number);
  const today = todayLocal();
  const targetDay = localHHMM() < captureTime ? today : addDays(today, 1);
  const [y, m, d] = targetDay.split("-").map(Number);
  const wallUTC = Date.UTC(y, m - 1, d, hh, mm, 0);
  const off = tzOffsetMs(new Date(wallUTC), TRACKING_TZ);
  return new Date(wallUTC - off).toISOString();
}

/** Список дней [from..to] включительно (YYYY-MM-DD). */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard++ < 2000) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}
