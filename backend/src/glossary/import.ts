import "dotenv/config";
import { google } from "googleapis";
import { getDb } from "../db/index";
import { parseCpf, parsePartnerName, parseRevshare } from "./parse";

const SHEET_ID = process.env.GLOSSARY_SHEET_ID;
const TAB = process.env.GLOSSARY_TAB || "Лист1";
const CREDS = process.env.GOOGLE_CREDENTIALS_PATH;

if (!SHEET_ID) throw new Error("GLOSSARY_SHEET_ID not set");
if (!CREDS) throw new Error("GOOGLE_CREDENTIALS_PATH not set");

interface SheetRow {
  partner: string;
  type: string;
  source: string;
  campaign: string;
  ofUrl: string;
  cpf: string;
  revshare: string;
  creator: string;
}

async function fetchSheet(): Promise<SheetRow[]> {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth: auth as never });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:K2000`,
  });
  const rows = res.data.values ?? [];
  return rows
    .map((r) => ({
      partner: (r[0] ?? "").toString().trim(),
      type: (r[1] ?? "").toString().trim(),
      source: (r[2] ?? "").toString().trim(),
      campaign: (r[3] ?? "").toString().trim(),
      ofUrl: (r[4] ?? "").toString().trim(),
      cpf: (r[5] ?? "").toString().trim(),
      revshare: (r[6] ?? "").toString().trim(),
      creator: (r[9] ?? "").toString().trim(),
    }))
    .filter((r) => r.partner && r.ofUrl);
}

async function run() {
  console.log(`Reading Glossary (sheet=${SHEET_ID}, tab=${TAB})...`);
  const rows = await fetchSheet();
  console.log(`Got ${rows.length} non-empty rows.`);

  const db = getDb();
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

  const partnersSeen = new Set<string>();
  let linksInserted = 0;
  let partnersInserted = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      const { displayName, telegram } = parsePartnerName(row.partner);
      const { free, paid } = parseCpf(row.cpf);
      const rev = parseRevshare(row.revshare);

      const glossaryName = row.partner;
      upsertPartner.run(
        glossaryName,
        displayName,
        telegram,
        row.type || null,
        row.source || null,
      );
      if (!partnersSeen.has(glossaryName)) {
        partnersSeen.add(glossaryName);
        partnersInserted++;
      }

      const pid = (selectPartnerId.get(glossaryName) as { id: number } | undefined)?.id;
      if (!pid) continue;

      upsertLink.run(
        pid,
        row.creator || "(unknown)",
        row.campaign,
        row.ofUrl,
        free,
        paid,
        rev,
        row.source || null,
      );
      linksInserted++;
    }
  });

  tx();

  console.log(`✓ Partners upserted: ${partnersInserted}`);
  console.log(`✓ Links upserted:    ${linksInserted}`);

  const stats = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM partners) AS partners,
         (SELECT COUNT(*) FROM links)    AS links,
         (SELECT COUNT(DISTINCT creator) FROM links) AS creators`,
    )
    .get() as { partners: number; links: number; creators: number };
  console.log(`DB now has: ${stats.partners} partners, ${stats.links} links, ${stats.creators} creators`);
}

run().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
