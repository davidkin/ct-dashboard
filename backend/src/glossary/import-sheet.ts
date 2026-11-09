/**
 * Импорт глоссария модели из ОТДЕЛЬНОЙ таблицы (у Kimi свой файл, не общий глоссарий).
 *
 * Якоримся на ячейку с кодом кампании (camp_*), а не на заголовки:
 *   code-1 = SOURCE, code+1 = OF LINK, code+2 = CPF, code+3 = RevShare, code+6 = Creator;
 *   первая ячейка — партнёр «Имя | @ник», дальше тип (In-house/External).
 *
 * Партнёр ищется по @нику среди существующих (чтобы не плодить дубли с прошлых
 * моделей), иначе создаётся новый. Строки без партнёра (OWN, пустые) пропускаем.
 *
 * CPF модели пишется в ссылку и в cpf_history партнёра с даты первой ссылки:
 * отчёты берут ставку партнёра раньше ставки ссылки, а у партнёров с прошлых
 * моделей она могла быть другой.
 *
 * Использование:
 *   npx tsx src/glossary/import-sheet.ts --sheet <id> --tab Kinkimi --creator Kimi            # dry-run
 *   npx tsx src/glossary/import-sheet.ts --sheet <id> --tab Kinkimi --creator Kimi --apply
 */
import "dotenv/config";
import { google } from "googleapis";
import { getDb } from "../db/index";
import { parseCpf, parsePartnerName, parseRevshare } from "./parse";
import { isPaidCampaign } from "../config/creators";

const CREDS = process.env.GOOGLE_CREDENTIALS_PATH;
if (!CREDS) throw new Error("GOOGLE_CREDENTIALS_PATH not set");

const CODE_RE = /^camp_[a-z0-9_]+$/i;

export interface SheetRow {
  rowNumber: number;
  partner: string;
  name: string;
  telegram: string | null;
  type: string | null;
  source: string | null;
  campaign: string;
  ofUrl: string;
  cpf: string;
  revshare: string;
  creator: string;
}

/* Смещения колонок относительно OF CAMPAIGN. По умолчанию — раскладка вкладки
   Kinkimi; если в листе есть заголовок, берём смещения из него (во вкладке
   Nikki между OF LINK и CPF стоят пустая колонка и Dashboard). */
function columnOffsets(rows: string[][]) {
  const offsets = { link: 1, cpf: 2, rev: 3, creator: 6 };
  const header = rows.find((r) => r.some((c) => String(c ?? "").trim().toUpperCase() === "OF CAMPAIGN"));
  if (!header) return offsets;
  const h = header.map((c) => String(c ?? "").trim().toUpperCase());
  const base = h.indexOf("OF CAMPAIGN");
  const at = (name: string, fallback: number) => (h.indexOf(name) >= 0 ? h.indexOf(name) - base : fallback);
  return {
    link: at("OF LINK", offsets.link),
    cpf: at("CPF", offsets.cpf),
    rev: at("REVSHARE", offsets.rev),
    creator: at("CREATOR", offsets.creator),
  };
}

export function extractSheetRows(rows: string[][], creatorPrefix: string): SheetRow[] {
  const wanted = creatorPrefix.trim().toLowerCase();
  const off = columnOffsets(rows);
  const out: SheetRow[] = [];
  rows.forEach((raw, i) => {
    const row = raw.map((c) => String(c ?? "").trim());
    const ci = row.findIndex((c) => CODE_RE.test(c));
    if (ci < 1) return;
    const ofUrl = row[ci + off.link] ?? "";
    const creator = row[ci + off.creator] ?? "";
    if (!ofUrl.startsWith("http") || !creator.toLowerCase().startsWith(wanted)) return;

    const left = row.slice(0, ci - 1);
    const partner = left[0] ?? "";
    const { displayName, telegram } = parsePartnerName(partner);
    const type = left.find((c) => /^(in-house|external)$/i.test(c)) ?? null;
    out.push({
      rowNumber: i + 1,
      partner,
      name: partner ? displayName : "",
      telegram,
      type,
      source: row[ci - 1] || null,
      campaign: row[ci],
      ofUrl,
      cpf: row[ci + off.cpf] ?? "",
      revshare: row[ci + off.rev] ?? "",
      creator,
    });
  });
  return out;
}

async function fetchRows(sheetId: string, tab: string): Promise<string[][]> {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth: auth as never });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tab}'!A1:Z2000` });
  return (res.data.values ?? []) as string[][];
}

async function run() {
  const args = process.argv.slice(2);
  const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const sheetId = arg("--sheet");
  const tab = arg("--tab") ?? "Лист1";
  const creatorPrefix = arg("--creator");
  const apply = args.includes("--apply");
  if (!sheetId || !creatorPrefix) throw new Error("usage: --sheet <id> --tab <name> --creator <prefix> [--apply]");

  const all = extractSheetRows(await fetchRows(sheetId, tab), creatorPrefix);
  const rows = all.filter((r) => r.name && r.name.toUpperCase() !== "OWN");
  const skipped = all.filter((r) => !rows.includes(r)).map((r) => r.campaign);
  console.log(`Sheet ${sheetId} tab=${tab}, creator "${creatorPrefix}", mode=${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Rows: ${all.length}, with partner: ${rows.length}, skipped (OWN/empty): ${skipped.join(", ") || "-"}`);

  const db = getDb();
  const byTelegram = db.prepare(
    `SELECT id, glossary_name FROM partners
      WHERE lower(telegram) = lower(?) AND COALESCE(archived, 0) = 0
      ORDER BY (glossary_name LIKE '%|%') DESC, id DESC LIMIT 1`,
  );
  const byGlossaryName = db.prepare(`SELECT id, glossary_name FROM partners WHERE glossary_name = ?`);

  const findPartner = (telegram: string | null, glossaryName: string) =>
    ((telegram ? byTelegram.get(telegram) : undefined) ?? byGlossaryName.get(glossaryName)) as
      | { id: number; glossary_name: string }
      | undefined;

  const plan = rows.map((r) => {
    const glossaryName = r.partner;
    const existing = findPartner(r.telegram, glossaryName);
    const cpf = parseCpf(r.cpf).free;
    return { r, glossaryName, existing, cpf, rev: parseRevshare(r.revshare), paid: isPaidCampaign(r.campaign) };
  });

  for (const p of plan) {
    console.log(
      `  row${p.r.rowNumber} ${p.r.campaign.padEnd(18)} ${p.r.creator.padEnd(9)} ` +
        `${(p.existing ? `#${p.existing.id} ${p.existing.glossary_name}` : `NEW ${p.glossaryName}`).padEnd(40)} ` +
        `cpf=${p.cpf ?? "-"} rev=${p.rev ?? "-"} ${p.paid ? "paid" : "free"}`,
    );
  }
  if (!apply) {
    console.log("\nDRY-RUN: nothing written. Re-run with --apply.");
    return;
  }

  const insertPartner = db.prepare(
    `INSERT INTO partners (glossary_name, display_name, telegram, type, source) VALUES (?, ?, ?, ?, ?)`,
  );
  const upsertLink = db.prepare(`
    INSERT INTO links (partner_id, creator, campaign_code, of_url, cpf_free, cpf_paid, revshare_pct, source)
    VALUES (@pid, @creator, @code, @url, @cpf_free, @cpf_paid, @rev, @source)
    ON CONFLICT(of_url) DO UPDATE SET
      partner_id = excluded.partner_id, creator = excluded.creator, campaign_code = excluded.campaign_code,
      cpf_free = excluded.cpf_free, cpf_paid = excluded.cpf_paid, revshare_pct = excluded.revshare_pct,
      source = excluded.source, updated_at = datetime('now')
  `);
  const hasHistory = db.prepare(
    `SELECT 1 FROM cpf_history WHERE partner_id = ? AND tier = ? AND effective_from = ? AND cpf = ?`,
  );
  const insertHistory = db.prepare(
    `INSERT INTO cpf_history (partner_id, tier, cpf, effective_from, created_by) VALUES (?, ?, ?, ?, 'import-sheet')`,
  );
  const activate = db.prepare(`UPDATE partners SET active = 1, updated_at = datetime('now') WHERE id = ? AND COALESCE(active, 0) = 0`);
  const setPartnerCpf = (tier: "free" | "paid") =>
    db.prepare(`UPDATE partners SET cpf_${tier} = ?, updated_at = datetime('now') WHERE id = ?`);

  /* С какого дня действует ставка модели: --from (дата первой ссылки), иначе сегодня. */
  const from = arg("--from") ?? new Date().toISOString().slice(0, 10);
  let created = 0;
  let links = 0;
  let history = 0;
  db.transaction(() => {
    for (const p of plan) {
      /* Партнёр мог быть создан строкой выше (несколько кампаний у одного партнёра). */
      let pid = findPartner(p.r.telegram, p.glossaryName)?.id;
      if (!pid) {
        pid = Number(insertPartner.run(p.glossaryName, p.r.name, p.r.telegram, p.r.type, p.r.source).lastInsertRowid);
        created++;
      }
      /* Льёт на новую модель — значит активен, даже если со старыми был lost. */
      activate.run(pid);
      upsertLink.run({
        pid,
        creator: p.r.creator,
        code: p.r.campaign,
        url: p.r.ofUrl,
        cpf_free: p.paid ? null : p.cpf,
        cpf_paid: p.paid ? p.cpf : null,
        rev: p.rev,
        source: p.r.source,
      });
      links++;
      if (p.cpf != null) {
        const tier = p.paid ? "paid" : "free";
        setPartnerCpf(tier).run(p.cpf, pid);
        if (!hasHistory.get(pid, tier, from, p.cpf)) {
          insertHistory.run(pid, tier, p.cpf, from);
          history++;
        }
      }
    }
  })();
  console.log(`Links upserted: ${links}, new partners: ${created}, cpf_history rows: ${history} (from ${from})`);
}

if (process.argv[1]?.includes("import-sheet")) {
  run().catch((err) => {
    console.error("Import failed:", err);
    process.exit(1);
  });
}
