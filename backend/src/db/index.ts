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

  /* om_subscribed_at — РЕАЛЬНАЯ дата подписки из OnlyMonster (не expiry, не наблюдение).
     Заполняется om sync-ом, ledger использует как source_event_at. */
  if (subsCols.length > 0 && !subsCols.some((c) => c.name === "om_subscribed_at")) {
    db.exec("ALTER TABLE link_subscribers ADD COLUMN om_subscribed_at TEXT");
  }
  /* Индекс для дневного трекинга — бакетим сабы по реальной дате подписки. */
  db.exec("CREATE INDEX IF NOT EXISTS idx_link_subs_om ON link_subscribers(om_subscribed_at)");

  /* daily_link_clicks — ночной снэпшот накопительного счётчика кликов по каждой
     компании. Единственное, что джоб реально пишет: OnlyMonster отдаёт клики
     только текущим счётчиком без истории, поэтому day-over-day дельту считаем
     отсюда. Сабы/пейауты деривируются из реальных дат (om_subscribed_at). */
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_link_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      day TEXT NOT NULL,                 /* YYYY-MM-DD в TRACKING_TZ */
      clicks_cumulative INTEGER NOT NULL,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(link_id, day)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_clicks_link_day ON daily_link_clicks(link_id, day);
  `);

  /* daily_sheet_stats — точный снимок per-(link, day) из ручной таблицы Traffic
     Tracking (клики + фаны как ввёл партнёр). В отчёте перебивает OM-derived,
     чтобы цифры совпадали с таблицей. Источник правды по истории кликов. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_sheet_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      day TEXT NOT NULL,                 /* YYYY-MM-DD */
      clicks INTEGER NOT NULL DEFAULT 0,
      fans INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(link_id, day)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_sheet_link_day ON daily_sheet_stats(link_id, day);
  `);

  /* OnlyMonster transactions/chargebacks — реальная выручка с fan.id + датами. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS om_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      om_account_id TEXT NOT NULL,
      creator TEXT,
      of_id TEXT NOT NULL UNIQUE,
      fan_id TEXT,
      amount REAL,
      type TEXT,
      status TEXT,
      occurred_at TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_om_tx_fan ON om_transactions(fan_id);
    CREATE INDEX IF NOT EXISTS idx_om_tx_occurred ON om_transactions(occurred_at);

    CREATE TABLE IF NOT EXISTS om_chargebacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      om_account_id TEXT NOT NULL,
      of_id TEXT NOT NULL UNIQUE,
      fan_id TEXT,
      amount REAL,
      type TEXT,
      status TEXT,
      chargeback_at TEXT,
      transaction_at TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_om_cb_fan ON om_chargebacks(fan_id);
  `);
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
