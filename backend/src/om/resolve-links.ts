/**
 * Проставляет links.of_tracking_link_id по OnlyMonster: имя трекинг-ссылки в OM
 * совпадает с campaign_code. Без этого ночной capture не может сматчить клики.
 *
 * Матчим внутри аккаунта модели — коды уникальны только внутри неё.
 *
 * Использование:
 *   npx tsx src/om/resolve-links.ts --creator "Lily Free"   # dry-run
 *   npx tsx src/om/resolve-links.ts --creator "Lily Free" --apply
 *   npx tsx src/om/resolve-links.ts --all --apply
 */
import "dotenv/config";
import { getDb } from "../db/index";
import { getOMAccountForCreator } from "../config/creators";
import { listTrackingLinks } from "./client";

export interface ResolveResult {
  creator: string;
  om_account: string;
  om_links: number;
  matched: number;
  already_set: number;
  unmatched_codes: string[];
}

export async function resolveTrackingLinks(
  creator: string,
  opts: { apply?: boolean } = {},
): Promise<ResolveResult> {
  const db = getDb();
  const omAccount = getOMAccountForCreator(creator);
  if (!omAccount) throw new Error(`no OM account configured for creator "${creator}"`);

  const links = db
    .prepare(
      `SELECT id, campaign_code, of_tracking_link_id FROM links
       WHERE creator = ? AND campaign_code IS NOT NULL AND campaign_code <> ''`,
    )
    .all(creator) as Array<{ id: number; campaign_code: string; of_tracking_link_id: number | null }>;

  const omLinks = await listTrackingLinks(omAccount);
  const byName = new Map(omLinks.map((l) => [l.name, l]));

  const update = db.prepare(
    `UPDATE links SET of_tracking_link_id = ?, of_account_id = COALESCE(of_account_id, ?),
       last_synced_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  );

  let matched = 0;
  let alreadySet = 0;
  const unmatched: string[] = [];

  const tx = db.transaction(() => {
    for (const link of links) {
      const om = byName.get(link.campaign_code);
      if (!om) {
        unmatched.push(link.campaign_code);
        continue;
      }
      if (link.of_tracking_link_id === Number(om.id)) {
        alreadySet++;
        continue;
      }
      if (opts.apply) update.run(Number(om.id), omAccount, link.id);
      matched++;
    }
  });
  tx();

  return {
    creator,
    om_account: omAccount,
    om_links: omLinks.length,
    matched,
    already_set: alreadySet,
    unmatched_codes: unmatched,
  };
}

async function run() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const creators: string[] = [];
  if (args.includes("--all")) {
    const db = getDb();
    creators.push(
      ...(db.prepare(`SELECT DISTINCT creator FROM links ORDER BY creator`).all() as Array<{
        creator: string;
      }>).map((r) => r.creator),
    );
  } else {
    const idx = args.indexOf("--creator");
    if (idx === -1 || !args[idx + 1]) throw new Error('usage: --creator "Lily Free" [--apply] | --all [--apply]');
    creators.push(args[idx + 1]);
  }

  for (const creator of creators) {
    if (!getOMAccountForCreator(creator)) {
      console.log(`${creator}: OM-аккаунт не сконфигурирован, пропуск`);
      continue;
    }
    const res = await resolveTrackingLinks(creator, { apply });
    console.log(
      `${creator}: OM-ссылок ${res.om_links}, проставлено ${res.matched}, уже стояло ${res.already_set}` +
        (res.unmatched_codes.length ? `, без пары: ${res.unmatched_codes.join(",")}` : ""),
    );
  }
  console.log(apply ? "APPLY: записано." : "DRY-RUN: ничего не записано, повтори с --apply.");
}

if (process.argv[1]?.includes("resolve-links")) {
  run().catch((err) => {
    console.error("resolve failed:", err);
    process.exit(1);
  });
}
