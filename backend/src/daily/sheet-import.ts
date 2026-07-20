/**
 * Импорт ручных таблиц Traffic Tracking → daily_sheet_stats (ОДНОРАЗОВЫЙ слепок/сид).
 *
 * Снимает точный per-(компания, день) снимок клики + фаны как ввёл партнёр.
 * Читается тем же service account, что и Glossary (GOOGLE_CREDENTIALS_PATH).
 *
 * Раскладка вкладки «… | Total» (единый шаблон у всех партнёров):
 *   col 0   = Дата (DD.MM)
 *   col 1-5 = Total: Клики · Фаны · Конверт · Сумма · Status
 *   далее блоки компаний по 4 кол: Клики · Фаны · CR · Сумма
 *   код компании [camp_X]/[camp_paid_X] стоит в шапке (row 14) на старте блока
 *
 * Коды кампаний ГЛОБАЛЬНО уникальны → маппим camp_code → link_id по всей базе,
 * без привязки к партнёру. Одним прогоном сидим все таблицы из реестра.
 */
import { google } from "googleapis";
import { getDb } from "../db/index";

/** Реестр таблиц-сидов: имя (для отчёта) + spreadsheetId. Вкладка у всех «Velora | Total»
 *  (Jennie — пустой шаблон, пропускаем). Добавление партнёра = строка сюда. */
const SHEETS: Array<{ name: string; sheetId: string }> = [
  { name: "Adult Angels", sheetId: "1R9P8KGHGfV5Y4nVIxyDg7mBB6SyryVTFCSx5_aZsXP4" },
  { name: "TraffZone", sheetId: "1dbxXlnJ_lnDg8wMgRKLhQRCycKvSr8lAtrGMDJKoW1M" },
  { name: "@nosenkko", sheetId: "1MM788uJcFH5bp1bozFY789CoK6OAERtXyXeZ69-GmXM" },
  { name: "@awe2me", sheetId: "1PAW4gYG-9rMf5PDRGqx1Kbxzo8Tq8ckGbRSBWupqk_8" },
  { name: "@sahssssss", sheetId: "1BMRucue1eDGEoBtAsAmg-jA7igllvQM57Ubv7vYJ0h4" },
  { name: "@rprstsw88", sheetId: "1P99o7KxZc23AdZPdf_-c6TSKrIF9mUsPq4egB1UVjpM" },
  { name: "@magosym", sheetId: "1vMsnrxVlSxqKlvkjtXa73A1sEfwSIFkSuTJZbqaNt_g" },
  { name: "@Celestrix001", sheetId: "1p_2A12wDJ19JrlA8UeMT04aFzX-ICLcrrkLfYK0Jrl4" },
  { name: "@ZernoTag", sheetId: "15NuDjUz8DMRQmI2Sl_kyttH1KYEEGktlXl4uXp1SQBs" },
  { name: "@diamlan", sheetId: "1YyRA9U71q5kB4F4FeOH9Ox4aqitZyiQVVBnOAHDZsP0" },
  { name: "@vetalmg", sheetId: "1CmEHcVn9fsJ642ilBUCaZjw_l6ZUt7RpWhSx6i_y_Z4" },
  { name: "@postoffice4", sheetId: "11h-irsSOpYHEiENojVjh2z_Os0nBlkg3yGT1ESop0wI" },
  { name: "@chyrtyyy", sheetId: "1p-_g2SnHRz5tgUmq7mpwPLZlX9mKDeKlQev_xdORqFo" },
  { name: "@kantniy", sheetId: "1NThKhMYOQhbqC6WaGaxKUr1k_cb7zuO2Sv2cWewc0S0" },
  { name: "@ElmoSaniBoi", sheetId: "1uj2Yac6PVagtvTkuXxtHGsqqFc4w_v-PnKeCYYj6KR0" },
  { name: "@innawork83", sheetId: "1qQMAAEWIl0ukwO7P3OYJ7HmwM85xb3kMmRrORdx7F_0" },
  { name: "@Skivly", sheetId: "1c1qzUja8FSw0OuV09II9SsKJo8pb9x0DMsbYkldlYOw" },
  { name: "@pullupinmyx6", sheetId: "1XWClXQREAnmP7npcpDd6Fxcv1Qin-fJi_Fq5L0hKA6g" },
];

const TAB = "Velora | Total";

export interface SheetImportResult {
  name: string;
  sheet_id: string;
  rows_imported: number;
  skipped_reset_rows: number;
  campaigns_matched: string[];
  campaigns_unmatched: string[];
  min_day: string | null;
  max_day: string | null;
  error?: string;
}

function num(s: unknown): number {
  const n = parseInt(String(s ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

export async function importTrafficSheet(): Promise<SheetImportResult[]> {
  const creds = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!creds) throw new Error("GOOGLE_CREDENTIALS_PATH not set");

  const auth = new google.auth.GoogleAuth({
    keyFile: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth: auth as never });
  const db = getDb();

  /* ГЛОБАЛЬНЫЙ маппинг camp_code → link_id (коды уникальны по всей базе) */
  const linkMap = new Map<string, number>();
  for (const row of db
    .prepare(`SELECT campaign_code, id FROM links WHERE campaign_code IS NOT NULL AND campaign_code <> ''`)
    .all() as Array<{ campaign_code: string; id: number }>) {
    linkMap.set(row.campaign_code, row.id);
  }

  const upsert = db.prepare(`
    INSERT INTO daily_sheet_stats (link_id, day, clicks, fans, imported_at)
    VALUES (@link_id, @day, @clicks, @fans, datetime('now'))
    ON CONFLICT(link_id, day) DO UPDATE SET
      clicks = excluded.clicks, fans = excluded.fans, imported_at = datetime('now')
  `);

  const dateRe = /(\d{2})\.(\d{2})/;
  const results: SheetImportResult[] = [];

  for (const { name, sheetId } of SHEETS) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${TAB}'!A14:CN400`,
        valueRenderOption: "FORMATTED_VALUE",
      });
      const rows = (res.data.values ?? []) as string[][];
      const header = rows[0] ?? [];

      /* компании: сканируем всю шапку, код на старте блока → clicks=col, fans=col+1 */
      const camps: Array<{ code: string; col: number }> = [];
      for (let i = 0; i < header.length; i++) {
        const m = String(header[i] ?? "").trim().match(/\[(camp_\w+)\]/);
        if (m) camps.push({ code: m[1], col: i });
      }

      const matched = new Set<string>();
      const unmatched = new Set<string>();
      let imported = 0;
      let skippedResets = 0;
      let minDay: string | null = null;
      let maxDay: string | null = null;

      const tx = db.transaction(() => {
        /* полный рефреш: чистим значения по компаниям, встреченным в ЭТОЙ таблице */
        const ids = camps.map((c) => linkMap.get(c.code)).filter((x): x is number => !!x);
        if (ids.length) {
          db.prepare(
            `DELETE FROM daily_sheet_stats WHERE link_id IN (${ids.map(() => "?").join(",")})`,
          ).run(...ids);
        }
        for (let r = 2; r < rows.length; r++) {
          const row = rows[r] ?? [];
          const dm = String(row[0] ?? "").trim().match(dateRe);
          if (!dm) continue;
          /* строка месячного «сброса» (отрицательный Total) — не дневные данные */
          if (num(row[1]) < 0) {
            skippedResets++;
            continue;
          }
          const day = `2026-${dm[2]}-${dm[1]}`; // DD.MM → 2026-MM-DD
          for (const c of camps) {
            const clicks = num(row[c.col]);
            const fans = num(row[c.col + 1]);
            if (!clicks && !fans) continue;
            const linkId = linkMap.get(c.code);
            if (!linkId) {
              unmatched.add(c.code);
              continue;
            }
            upsert.run({ link_id: linkId, day, clicks, fans });
            matched.add(c.code);
            imported++;
            if (!minDay || day < minDay) minDay = day;
            if (!maxDay || day > maxDay) maxDay = day;
          }
        }
      });
      tx();

      results.push({
        name,
        sheet_id: sheetId,
        rows_imported: imported,
        skipped_reset_rows: skippedResets,
        campaigns_matched: [...matched],
        campaigns_unmatched: [...unmatched],
        min_day: minDay,
        max_day: maxDay,
      });
    } catch (err) {
      results.push({
        name,
        sheet_id: sheetId,
        rows_imported: 0,
        skipped_reset_rows: 0,
        campaigns_matched: [],
        campaigns_unmatched: [],
        min_day: null,
        max_day: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
