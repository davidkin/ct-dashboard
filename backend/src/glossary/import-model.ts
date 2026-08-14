/**
 * Импорт линков одной модели из Glossary по ИМЕНАМ колонок.
 *
 * Отличия от import.ts (который читает фиксированные индексы и потому ломается,
 * когда в лист добавляют колонку):
 *   - колонки резолвятся по заголовку ("OF CAMPAIGN", "OF LINK", "Creator", ...);
 *   - лист состоит из нескольких секций, у каждой своя строка заголовка — учитываем все;
 *   - берём только строки нужной модели (--creator Lily), чужие не трогаем;
 *   - по умолчанию dry-run: печатает, что будет записано, и ничего не пишет.
 *
 * Использование:
 *   npx tsx src/glossary/import-model.ts --creator Lily            # dry-run
 *   npx tsx src/glossary/import-model.ts --creator Lily --apply    # запись
 */
import "dotenv/config";
import { google } from "googleapis";
import { getDb } from "../db/index";
import { parseCpf, parsePartnerName, parseRevshare } from "./parse";

const SHEET_ID = process.env.GLOSSARY_SHEET_ID;
const TAB = process.env.GLOSSARY_TAB || "Лист1";
const CREDS = process.env.GOOGLE_CREDENTIALS_PATH;

if (!SHEET_ID) throw new Error("GLOSSARY_SHEET_ID not set");
if (!CREDS) throw new Error("GOOGLE_CREDENTIALS_PATH not set");

/** Заголовок → поле. Сравнение по нормализованному тексту (регистр/пробелы не важны). */
const COLUMN_ALIASES: Record<string, string> = {
  partner: "partner",
  affiliates: "type",
  source: "source",
  "of campaign": "campaign",
  "of link": "ofUrl",
  cpf: "cpf",
  revshare: "revshare",
  creator: "creator",
};

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export interface ModelRow {
  rowNumber: number;
  partner: string;
  type: string;
  source: string;
  campaign: string;
  ofUrl: string;
  cpf: string;
  revshare: string;
  creator: string;
}

/** Разбирает лист с несколькими секциями: каждая строка "PARTNER ..." задаёт раскладку для следующих строк. */
export function extractRows(rows: string[][], creatorPrefix: string): ModelRow[] {
  const wanted = creatorPrefix.trim().toLowerCase();
  let map: Record<string, number> | null = null;
  const out: ModelRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (norm(row[0]) === "partner") {
      map = {};
      row.forEach((cell, idx) => {
        const field = COLUMN_ALIASES[norm(cell)];
        if (field && !(field in map!)) map![field] = idx;
      });
      continue;
    }
    if (!map) continue;

    const get = (field: string) =>
      map![field] === undefined ? "" : String(row[map![field]] ?? "").trim();

    const partner = get("partner");
    const ofUrl = get("ofUrl");
    const creator = get("creator");
    if (!partner || !ofUrl || !creator) continue;
    if (!creator.toLowerCase().startsWith(wanted)) continue;

    out.push({
      rowNumber: i + 1,
      partner,
      type: get("type"),
      source: get("source"),
      campaign: get("campaign"),
      ofUrl,
      cpf: get("cpf"),
      revshare: get("revshare"),
      creator,
    });
  }
  return out;
}

async function fetchRows(): Promise<string[][]> {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth: auth as never });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A1:Z2000`,
  });
  return (res.data.values ?? []) as string[][];
}

async function run() {
  const args = process.argv.slice(2);
  const creatorArg = args[args.indexOf("--creator") + 1];
  const creatorPrefix = args.includes("--creator") && creatorArg ? creatorArg : "";
  const apply = args.includes("--apply");
  if (!creatorPrefix) throw new Error("usage: --creator <prefix> [--apply]");

  console.log(`Glossary sheet=${SHEET_ID} tab=${TAB}, creator prefix "${creatorPrefix}", mode=${apply ? "APPLY" : "DRY-RUN"}`);
  const rows = extractRows(await fetchRows(), creatorPrefix);
  console.log(`Matched rows: ${rows.length}`);
  if (!rows.length) return;

  const byCreator = new Map<string, number>();
  for (const r of rows) byCreator.set(r.creator, (byCreator.get(r.creator) ?? 0) + 1);
  console.log("By creator:", [...byCreator].map(([c, n]) => `${c}=${n}`).join(", "));

  /* дубли of_url внутри выборки — of_url UNIQUE, последняя строка перезапишет предыдущую */
  const urlSeen = new Map<string, number>();
  for (const r of rows) {
    const prev = urlSeen.get(r.ofUrl);
    if (prev) console.warn(`! duplicate of_url in sheet: rows ${prev} и ${r.rowNumber} → ${r.ofUrl}`);
    urlSeen.set(r.ofUrl, r.rowNumber);
  }

  const db = getDb();

  /* коллизии campaign_code с уже существующими линками ДРУГИХ моделей — это норма,
     связка теперь по паре (creator, campaign_code); просто показываем масштаб */
  const existingCodes = new Set(
    (db.prepare(`SELECT DISTINCT campaign_code FROM links`).all() as Array<{ campaign_code: string }>)
      .map((r) => r.campaign_code),
  );
  const clashes = rows.filter((r) => existingCodes.has(r.campaign)).length;
  console.log(`campaign_code, уже занятых другой моделью: ${clashes} (мапинг должен быть по паре creator+code)`);

  const known = new Set(
    (db.prepare(`SELECT of_url FROM links`).all() as Array<{ of_url: string }>).map((r) => r.of_url),
  );
  const toInsert = rows.filter((r) => !known.has(r.ofUrl)).length;
  console.log(`Новых линков: ${toInsert}, обновлений существующих: ${rows.length - toInsert}`);

  if (!apply) {
    console.log("\nПримеры (первые 5):");
    for (const r of rows.slice(0, 5)) {
      console.log(`  row${r.rowNumber} | ${r.creator} | ${r.campaign} | ${r.partner} | ${r.ofUrl}`);
    }
    console.log("\nDRY-RUN: ничего не записано. Повтори с --apply.");
    return;
  }

  const upsertPartner = db.prepare(`
    INSERT INTO partners (glossary_name, display_name, telegram, type, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(glossary_name) DO UPDATE SET
      display_name = excluded.display_name,
      telegram     = excluded.telegram,
      type         = COALESCE(excluded.type, partners.type),
      source       = COALESCE(excluded.source, partners.source),
      updated_at   = datetime('now')
  `);
  const selectPartnerId = db.prepare(`SELECT id FROM partners WHERE glossary_name = ?`);
  const upsertLink = db.prepare(`
    INSERT INTO links
      (partner_id, creator, campaign_code, of_url, cpf_free, cpf_paid, revshare_pct, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(of_url) DO UPDATE SET
      partner_id    = excluded.partner_id,
      creator       = excluded.creator,
      campaign_code = excluded.campaign_code,
      cpf_free      = excluded.cpf_free,
      cpf_paid      = excluded.cpf_paid,
      revshare_pct  = excluded.revshare_pct,
      source        = excluded.source,
      updated_at    = datetime('now')
  `);

  const newPartners = new Set<string>();
  let linksUpserted = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      const { displayName, telegram } = parsePartnerName(row.partner);
      const { free, paid } = parseCpf(row.cpf);
      const rev = parseRevshare(row.revshare);

      const existing = selectPartnerId.get(row.partner) as { id: number } | undefined;
      if (!existing) newPartners.add(row.partner);
      upsertPartner.run(row.partner, displayName, telegram, row.type || null, row.source || null);

      const pid = (selectPartnerId.get(row.partner) as { id: number } | undefined)?.id;
      if (!pid) continue;

      upsertLink.run(pid, row.creator, row.campaign, row.ofUrl, free, paid, rev, row.source || null);
      linksUpserted++;
    }
  });
  tx();

  console.log(`✓ Links upserted: ${linksUpserted}`);
  console.log(`✓ New partners:   ${newPartners.size}${newPartners.size ? " → " + [...newPartners].join(", ") : ""}`);

  const stats = db
    .prepare(`SELECT creator, COUNT(*) n FROM links GROUP BY creator ORDER BY creator`)
    .all() as Array<{ creator: string; n: number }>;
  console.log("DB links by creator:", stats.map((s) => `${s.creator}=${s.n}`).join(", "));
}

if (process.argv[1]?.includes("import-model")) {
  run().catch((err) => {
    console.error("Import failed:", err);
    process.exit(1);
  });
}
