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

  /* partners: кошелёк + сеть для выплат (задаются при создании/редактировании партнёра). */
  const partnersCols = db.prepare("PRAGMA table_info(partners)").all() as Array<{ name: string }>;
  if (partnersCols.length > 0 && !partnersCols.some((c) => c.name === "wallet")) {
    db.exec("ALTER TABLE partners ADD COLUMN wallet TEXT");
  }
  if (partnersCols.length > 0 && !partnersCols.some((c) => c.name === "network")) {
    db.exec("ALTER TABLE partners ADD COLUMN network TEXT");
  }
  /* CPF — свойство ПАРТНЁРА (Free CPF + Paid CPF), не линка. Линк берёт CPF партнёра по tier. */
  if (partnersCols.length > 0 && !partnersCols.some((c) => c.name === "cpf_free")) {
    db.exec("ALTER TABLE partners ADD COLUMN cpf_free REAL");
    /* бэкфилл из линков для существующих партнёров (значения по партнёру одинаковые). */
    db.exec(
      `UPDATE partners SET cpf_free = (SELECT l.cpf_free FROM links l WHERE l.partner_id = partners.id AND l.cpf_free IS NOT NULL LIMIT 1) WHERE cpf_free IS NULL`,
    );
  }
  if (partnersCols.length > 0 && !partnersCols.some((c) => c.name === "cpf_paid")) {
    db.exec("ALTER TABLE partners ADD COLUMN cpf_paid REAL");
    db.exec(
      `UPDATE partners SET cpf_paid = (SELECT l.cpf_paid FROM links l WHERE l.partner_id = partners.id AND l.cpf_paid IS NOT NULL LIMIT 1) WHERE cpf_paid IS NULL`,
    );
  }
  /* note — свободная заметка на партнёра (значок «!» в аналитике: серый пустой, акцент если есть текст). */
  if (partnersCols.length > 0 && !partnersCols.some((c) => c.name === "note")) {
    db.exec("ALTER TABLE partners ADD COLUMN note TEXT");
  }
  /* archived — 0/1. Архивный партнёр исключён из таблицы «Все партнёры» и KPI-счётчика, но не удалён. */
  if (partnersCols.length > 0 && !partnersCols.some((c) => c.name === "archived")) {
    db.exec("ALTER TABLE partners ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }

  /* payout_status — статус выплаты партнёру за конкретную неделю (Пн–Вс).
     week_start = YYYY-MM-DD понедельника. status: 'pending' | 'done'.
     Выплаты по понедельникам за прошлую неделю; в аналитике бейдж Готов/Ожидает. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS payout_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      week_start TEXT NOT NULL,          /* YYYY-MM-DD, понедельник недели */
      status TEXT NOT NULL DEFAULT 'pending',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(partner_id, week_start)
    );
    CREATE INDEX IF NOT EXISTS idx_payout_status_partner ON payout_status(partner_id, week_start);
  `);

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
      fans_cumulative INTEGER,           /* cum «ФАНЫ ВСЕ» по ссылке на день (OM subscribers) */
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(link_id, day)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_clicks_link_day ON daily_link_clicks(link_id, day);
  `);
  /* fans_cumulative — для уже существующих БД (колонки могло не быть) */
  const dlcCols = db.prepare("PRAGMA table_info(daily_link_clicks)").all() as Array<{ name: string }>;
  if (dlcCols.length > 0 && !dlcCols.some((c) => c.name === "fans_cumulative")) {
    db.exec("ALTER TABLE daily_link_clicks ADD COLUMN fans_cumulative INTEGER");
  }

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

  /* daily_om_stats — ЗАМОРОЖЕННОЕ подневное значение (клики + фаны ЗА ДЕНЬ),
     посчитанное один раз при ночной вытяжке из OM (сегодня_накопит − вчера_накопит)
     и больше не пересчитываемое. Тот же принцип что ручное заполнение таблицы:
     дописываем строку за сегодня, старые дни не трогаем. Читается напрямую
     (сумма), без дельт на чтении. daily_link_clicks остаётся как техническое
     состояние (накопит.счётчик) только чтобы посчитать дельту при записи. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_om_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      day TEXT NOT NULL,                 /* YYYY-MM-DD в TRACKING_TZ */
      clicks INTEGER NOT NULL DEFAULT 0,
      fans INTEGER NOT NULL DEFAULT 0,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(link_id, day)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_om_link_day ON daily_om_stats(link_id, day);
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
