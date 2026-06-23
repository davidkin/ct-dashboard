import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "./migrations";

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = process.env.DB_PATH || "./data/couture.db";
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schemaPath = path.resolve(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  migrate(db);
  runMigrations(db);

  dbInstance = db;
  return db;
}

/**
 * Лёгкие миграции для существующих БД, где может не быть новых колонок.
 * SQLite не поддерживает ALTER ... IF NOT EXISTS, поэтому проверяем сами.
 */
function migrate(db: Database.Database): void {
  const linksCols = db.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
  if (!linksCols.some((c) => c.name === "of_created_at")) {
    db.exec("ALTER TABLE links ADD COLUMN of_created_at TEXT");
  }

  /* first_seen_at — когда МЫ впервые увидели этого фана/спендера в OF API.
     Это наша «прокси-дата подписки», т.к. OF API напрямую не отдаёт subscribed_at. */
  const subsCols = db.prepare("PRAGMA table_info(link_subscribers)").all() as Array<{ name: string }>;
  if (subsCols.length > 0 && !subsCols.some((c) => c.name === "first_seen_at")) {
    db.exec("ALTER TABLE link_subscribers ADD COLUMN first_seen_at TEXT");
    db.exec("UPDATE link_subscribers SET first_seen_at = fetched_at WHERE first_seen_at IS NULL");
  }
  const spendersCols = db.prepare("PRAGMA table_info(link_spenders)").all() as Array<{ name: string }>;
  if (spendersCols.length > 0 && !spendersCols.some((c) => c.name === "first_seen_at")) {
    db.exec("ALTER TABLE link_spenders ADD COLUMN first_seen_at TEXT");
    db.exec("UPDATE link_spenders SET first_seen_at = fetched_at WHERE first_seen_at IS NULL");
  }
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
