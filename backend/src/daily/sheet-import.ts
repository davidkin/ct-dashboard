/**
 * Импорт ручной таблицы Traffic Tracking → daily_sheet_stats.
 *
 * Снимает точный per-(компания, день) снимок клики + фаны как ввёл партнёр.
 * Читается тем же service account, что и Glossary (GOOGLE_CREDENTIALS_PATH).
 *
 * Раскладка вкладки «… | Total» (выверено по живым данным):
 *   col 0   = Дата (DD.MM)
 *   col 1-5 = Total: Клики · Фаны · Конверт · Сумма · Status
 *   далее блоки компаний с col 7, каждый 4 кол: Клики · Фаны · CR · Сумма
 *   код компании [camp_X] стоит в шапке (row 14) на старте блока
 *
 * Маппинг: вкладка привязана к партнёру; код компании → наш link по
 * (campaign_code + этот партнёр). У Adult Angels коды уникальны → 1:1.
 */
import { google } from "googleapis";
import { getDb } from "../db/index";

const SHEET_ID = "1R9P8KGHGfV5Y4nVIxyDg7mBB6SyryVTFCSx5_aZsXP4";

/** вкладка → партнёр-владелец её компаний (его строки в Glossary) */
const TABS: Array<{ tab: string; partner: string }> = [
  { tab: "Velora | Total", partner: "Adult Angels" },
];

export interface SheetImportResult {
  tab: string;
  partner: string;
  rows_imported: number;
  skipped_reset_rows: number;
  campaigns_matched: string[];
  campaigns_unmatched: string[];
  min_day: string | null;
  max_day: string | null;
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

  const upsert = db.prepare(`
    INSERT INTO daily_sheet_stats (link_id, day, clicks, fans, imported_at)
    VALUES (@link_id, @day, @clicks, @fans, datetime('now'))
    ON CONFLICT(link_id, day) DO UPDATE SET
      clicks = excluded.clicks, fans = excluded.fans, imported_at = datetime('now')
  `);

  const results: SheetImportResult[] = [];

  for (const { tab, partner } of TABS) {
    /* camp_code → наш link_id для компаний этого партнёра */
    const linkMap = new Map<string, number>();
    for (const row of db
      .prepare(
        `SELECT l.campaign_code, l.id
         FROM links l JOIN partners p ON p.id = l.partner_id
         WHERE p.display_name = ?`,
      )
      .all(partner) as Array<{ campaign_code: string; id: number }>) {
      linkMap.set(row.campaign_code, row.id);
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tab}'!A14:CN400`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = (res.data.values ?? []) as string[][];
    const header = rows[0] ?? [];

    /* компании из шапки: код на старте блока, шаг 4, с col 7 */
    const camps: Array<{ code: string; col: number }> = [];
    for (let i = 7; i < header.length; i += 4) {
      const m = String(header[i] ?? "").trim().match(/\[(camp_\w+)\]/);
      if (m) camps.push({ code: m[1], col: i });
    }

    const dateRe = /(\d{2})\.(\d{2})/;
    const matched = new Set<string>();
    const unmatched = new Set<string>();
    let imported = 0;
    let skippedResets = 0;
    let minDay: string | null = null;
    let maxDay: string | null = null;

    const tx = db.transaction(() => {
      /* чистим старые значения по компаниям этого партнёра — полный рефреш */
      const ids = [...linkMap.values()];
      if (ids.length) {
        db.prepare(`DELETE FROM daily_sheet_stats WHERE link_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
      }
      for (let r = 2; r < rows.length; r++) {
        const row = rows[r] ?? [];
        const dm = String(row[0] ?? "").trim().match(dateRe);
        if (!dm) continue;
        /* Строка месячного «сброса»: партнёр вписывает отрицательный Total,
           чтобы обнулить кумулятив на конец месяца. Это не дневные данные. */
        if (num(row[1]) < 0) { skippedResets++; continue; }
        const day = `2026-${dm[2]}-${dm[1]}`; // DD.MM → 2026-MM-DD
        for (const c of camps) {
          const clicks = num(row[c.col]);
          const fans = num(row[c.col + 1]);
          if (!clicks && !fans) continue;
          const linkId = linkMap.get(c.code);
          if (!linkId) { unmatched.add(c.code); continue; }
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
      tab,
      partner,
      rows_imported: imported,
      skipped_reset_rows: skippedResets,
      campaigns_matched: [...matched],
      campaigns_unmatched: [...unmatched],
      min_day: minDay,
      max_day: maxDay,
    });
  }

  return results;
}
