import Database from "better-sqlite3";

/**
 * Лёгкий migration-runner для fan-level ledger (Phase 1).
 *
 * - Каждая миграция идемпотентна (CREATE TABLE IF NOT EXISTS) и применяется один раз,
 *   факт применения пишется в `_migrations`.
 * - Существующие таблицы (partners/links/snapshots/...) НЕ трогаются — только добавляем.
 */
interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: "001_fan_attribution_ledger",
    sql: `
    /* ===== Global Fan: одна внутренняя сущность на человека ===== */
    CREATE TABLE IF NOT EXISTS fans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      primary_of_fan_id TEXT,
      primary_username TEXT,
      normalized_username TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fans_primary_of_fan_id
      ON fans(primary_of_fan_id) WHERE primary_of_fan_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_fans_norm_username ON fans(normalized_username);

    /* ===== Конкретная OnlyFans-identity, привязанная к Global Fan ===== */
    CREATE TABLE IF NOT EXISTS fan_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fan_id INTEGER NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
      of_account_id TEXT,
      creator TEXT,
      model_group TEXT,
      of_fan_id TEXT,
      username TEXT,
      normalized_username TEXT,
      source_endpoint TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fan_identities_acct_fan
      ON fan_identities(of_account_id, of_fan_id) WHERE of_fan_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_fan_identities_of_fan_id ON fan_identities(of_fan_id);
    CREATE INDEX IF NOT EXISTS idx_fan_identities_norm_username ON fan_identities(normalized_username);
    CREATE INDEX IF NOT EXISTS idx_fan_identities_fan ON fan_identities(fan_id);

    /* ===== Evidence-слой связей между identities ===== */
    CREATE TABLE IF NOT EXISTS fan_identity_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fan_id INTEGER REFERENCES fans(id) ON DELETE CASCADE,
      identity_a_id INTEGER NOT NULL REFERENCES fan_identities(id) ON DELETE CASCADE,
      identity_b_id INTEGER NOT NULL REFERENCES fan_identities(id) ON DELETE CASCADE,
      match_method TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      is_exact INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(identity_a_id, identity_b_id, match_method)
    );
    CREATE INDEX IF NOT EXISTS idx_fan_matches_fan ON fan_identity_matches(fan_id);

    /* ===== Главный event ledger ===== */
    CREATE TABLE IF NOT EXISTS fan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fan_id INTEGER REFERENCES fans(id) ON DELETE CASCADE,
      identity_id INTEGER REFERENCES fan_identities(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      of_account_id TEXT,
      creator TEXT,
      model_group TEXT,
      link_id INTEGER REFERENCES links(id) ON DELETE SET NULL,
      partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
      source TEXT NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_event_at TEXT,
      is_inferred INTEGER NOT NULL DEFAULT 0,
      dedupe_key TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fan_events_dedupe
      ON fan_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_fan_events_fan ON fan_events(fan_id);
    CREATE INDEX IF NOT EXISTS idx_fan_events_type ON fan_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_fan_events_observed ON fan_events(observed_at);
    CREATE INDEX IF NOT EXISTS idx_fan_events_link ON fan_events(link_id);

    /* ===== Touches: первое/повторное появление фана по ссылке (CPF-eligibility) ===== */
    CREATE TABLE IF NOT EXISTS fan_link_touches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fan_id INTEGER NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
      creator TEXT,
      of_account_id TEXT,
      model_group TEXT,
      touch_role TEXT NOT NULL,
      cpf_eligible INTEGER NOT NULL DEFAULT 0,
      first_touch_at TEXT,
      source_event_at TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      match_confidence REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(fan_id, link_id)
    );
    CREATE INDEX IF NOT EXISTS idx_touches_fan ON fan_link_touches(fan_id);
    CREATE INDEX IF NOT EXISTS idx_touches_link ON fan_link_touches(link_id);
    CREATE INDEX IF NOT EXISTS idx_touches_partner ON fan_link_touches(partner_id);
    CREATE INDEX IF NOT EXISTS idx_touches_role ON fan_link_touches(touch_role);

    /* ===== Деньги по фанам ===== */
    CREATE TABLE IF NOT EXISTS fan_revenue_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fan_id INTEGER REFERENCES fans(id) ON DELETE CASCADE,
      of_account_id TEXT,
      creator TEXT,
      model_group TEXT,
      transaction_id TEXT,
      amount REAL,
      net REAL,
      currency TEXT,
      revenue_type TEXT,
      occurred_at TEXT,
      link_id INTEGER REFERENCES links(id) ON DELETE SET NULL,
      attributed_partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
      attribution_type TEXT,
      raw_json TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_acct_tx
      ON fan_revenue_events(of_account_id, transaction_id) WHERE transaction_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_revenue_fan ON fan_revenue_events(fan_id);
    CREATE INDEX IF NOT EXISTS idx_revenue_occurred ON fan_revenue_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_revenue_partner ON fan_revenue_events(attributed_partner_id);

    /* ===== Учёт расхода API (credits / requests) ===== */
    CREATE TABLE IF NOT EXISTS api_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      endpoint TEXT,
      of_account_id TEXT,
      credits_used INTEGER,
      requests_count INTEGER NOT NULL DEFAULT 0,
      items_processed INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      status TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_usage_started ON api_usage_log(started_at);
    CREATE INDEX IF NOT EXISTS idx_api_usage_source ON api_usage_log(source);
    `,
  },
  {
    id: "002_touch_cpf_eligibility_reason",
    sql: `
    ALTER TABLE fan_link_touches ADD COLUMN cpf_eligibility_reason TEXT;
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  const applied = new Set(
    (db.prepare("SELECT id FROM _migrations").all() as { id: string }[]).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const tx = db.transaction(() => {
      try {
        db.exec(m.sql);
      } catch (err) {
        // Идемпотентность для ADD COLUMN: при дрейфе (_migrations ↔ реальная схема) колонка
        // может уже существовать — не падаем, считаем миграцию применённой. Прочее пробрасываем.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) throw err;
      }
      db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(m.id);
    });
    tx();
  }
}
