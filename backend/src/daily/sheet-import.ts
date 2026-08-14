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
 *   код компании в шапке (row 14) на старте блока: [camp_X] или просто camp_X
 *
 * У каждого партнёра свой таб на модель, и вкладки — клоны одного шаблона,
 * поэтому определяем модель по gid, а не по названию таба: часть партнёров
 * не переименовала шаблонный «Jennie | Total», хотя данные там уже Lily.
 *
 * Коды кампаний уникальны только ВНУТРИ модели (у Lily нумерация начинается
 * заново и пересекается с Nekoletta), поэтому маппим пару модель+код → link_id.
 */
import { google } from "googleapis";
import { getDb } from "../db/index";
import { getModelGroup } from "../config/creators";

/** Реестр таблиц-сидов: имя (для отчёта) + spreadsheetId. Добавление партнёра = строка сюда. */
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

/**
 * Вкладки — клоны одного шаблона, поэтому gid одинаковый во всех таблицах,
 * а название может быть неактуальным («Jennie | Total» с данными Lily).
 * model_group должен совпадать с getModelGroup() у creator-ов этой модели.
 */
const MODEL_TABS: Array<{ gid: number; modelGroup: string }> = [
  { gid: 508899617, modelGroup: "Nekoletta" },
  { gid: 46666697, modelGroup: "Lily" },
];

/** Код кампании в шапке: «[camp_44]» у одних моделей, «camp_2» у других. */
const CAMPAIGN_CODE_RE = /\[?(camp_[a-z0-9_]+)\]?/i;

export interface SheetImportResult {
  name: string;
  sheet_id: string;
  model: string;
  tab: string;
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

/** opts.models — импортировать только эти модели (по умолчанию все из MODEL_TABS). */
export async function importTrafficSheet(
  opts: { models?: string[] } = {},
): Promise<SheetImportResult[]> {
  const creds = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!creds) throw new Error("GOOGLE_CREDENTIALS_PATH not set");

  const models = opts.models?.length
    ? MODEL_TABS.filter((t) => opts.models!.includes(t.modelGroup))
    : MODEL_TABS;
  if (!models.length) throw new Error(`unknown models: ${opts.models?.join(", ")}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth: auth as never });
  const db = getDb();

  /* маппинг "модель::camp_code" → link_id: код уникален только внутри модели */
  const linkMap = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT campaign_code, creator, id FROM links WHERE campaign_code IS NOT NULL AND campaign_code <> ''`,
    )
    .all() as Array<{ campaign_code: string; creator: string; id: number }>) {
    const group = getModelGroup(row.creator);
    if (!group) continue;
    linkMap.set(`${group}::${row.campaign_code}`, row.id);
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
    /* название таба ненадёжно (шаблонный «Jennie» с данными Lily) → резолвим по gid */
    let tabByGid = new Map<number, string>();
    try {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: sheetId,
        fields: "sheets.properties(title,sheetId)",
      });
      tabByGid = new Map(
        (meta.data.sheets ?? []).map((s) => [s.properties?.sheetId ?? -1, s.properties?.title ?? ""]),
      );
    } catch (err) {
      for (const { modelGroup } of models) {
        results.push(emptyResult(name, sheetId, modelGroup, "", err));
      }
      continue;
    }

    for (const { gid, modelGroup } of models) {
      const tabTitle = tabByGid.get(gid);
      if (!tabTitle) {
        results.push(emptyResult(name, sheetId, modelGroup, "", `tab gid=${gid} not found`));
        continue;
      }
      try {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `'${tabTitle}'!A14:CN400`,
          valueRenderOption: "FORMATTED_VALUE",
        });
        const rows = (res.data.values ?? []) as string[][];
        const header = rows[0] ?? [];

        /* компании: сканируем всю шапку, код на старте блока → clicks=col, fans=col+1 */
        const camps: Array<{ code: string; col: number }> = [];
        for (let i = 0; i < header.length; i++) {
          const m = String(header[i] ?? "").trim().match(CAMPAIGN_CODE_RE);
          if (m) camps.push({ code: m[1], col: i });
        }

        const matched = new Set<string>();
        const unmatched = new Set<string>();
        let imported = 0;
        let skippedResets = 0;
        let minDay: string | null = null;
        let maxDay: string | null = null;
        const key = (code: string) => `${modelGroup}::${code}`;

        const tx = db.transaction(() => {
          /* полный рефреш: чистим значения по компаниям, встреченным в ЭТОМ табе */
          const ids = camps.map((c) => linkMap.get(key(c.code))).filter((x): x is number => !!x);
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
              const linkId = linkMap.get(key(c.code));
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
          model: modelGroup,
          tab: tabTitle,
          rows_imported: imported,
          skipped_reset_rows: skippedResets,
          campaigns_matched: [...matched],
          campaigns_unmatched: [...unmatched],
          min_day: minDay,
          max_day: maxDay,
        });
      } catch (err) {
        results.push(emptyResult(name, sheetId, modelGroup, tabTitle, err));
      }
    }
  }

  return results;
}

function emptyResult(
  name: string,
  sheetId: string,
  model: string,
  tab: string,
  err: unknown,
): SheetImportResult {
  return {
    name,
    sheet_id: sheetId,
    model,
    tab,
    rows_imported: 0,
    skipped_reset_rows: 0,
    campaigns_matched: [],
    campaigns_unmatched: [],
    min_day: null,
    max_day: null,
    error: err instanceof Error ? err.message : String(err),
  };
}
