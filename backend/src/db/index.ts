import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

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

  dbInstance = db;
  return db;
}

/**
 * Лёгкие миграции для существующих БД, где может не быть новых колонок.
 * SQLite не поддерживает ALTER ... IF NOT EXISTS, поэтому проверяем сами.
 */
function migrate(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has("of_created_at")) {
    db.exec("ALTER TABLE links ADD COLUMN of_created_at TEXT");
  }
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
