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
  {
    id: "003_users_and_sessions",
    sql: `
    /* ===== Пользователи приложения: вход внутри дашборда вместо общего пароля ===== */
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'manager',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /* Сессии в базе, а не в памяти: рестарт бэкенда не разлогинивает всех. */
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      last_seen_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `,
  },
  {
    id: "004_partner_om_report",
    sql: `
    /* Ссылка на shared-отчёт партнёра в кабинете OnlyMonster — для сверки цифр глазами. */
    ALTER TABLE partners ADD COLUMN om_report_url TEXT;
    `,
  },
  {
    id: "005_login_whitelist_and_cabinet",
    sql: `
    /* Вайт-лист почт: кого пускать в логин-окно и с какой ролью. Аккаунт в users
       создаётся сам при первом входе с этой почтой (self-serve — слать письма нечем). */
    CREATE TABLE IF NOT EXISTS allowed_emails (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      added_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /* Личный кабинет траффера: секретная ссылка на его же карточку партнёра,
       без логина — ровно как shared report в OnlyMonster. */
    ALTER TABLE partners ADD COLUMN share_token TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_share_token
      ON partners(share_token) WHERE share_token IS NOT NULL;
    `,
  },
  {
    id: "006_cpf_history",
    sql: `
    /* История ставок CPF по партнёру и тиру (free/paid), с датой, с которой
       ставка начала действовать. Пока для партнёра нет ни одной строки здесь —
       выплата считается по partners.cpf_free/cpf_paid как раньше, без изменений.
       Как только появляется первая запись — day-by-day расчёт в buildDailyReport
       переходит на неё: каждый день считается по ставке, действовавшей именно
       в этот день, а не по текущей. */
    CREATE TABLE IF NOT EXISTS cpf_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      tier TEXT NOT NULL CHECK (tier IN ('free','paid')),
      cpf REAL NOT NULL,
      effective_from TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cpf_history_lookup
      ON cpf_history(partner_id, tier, effective_from);
    `,
  },
  {
    id: "007_fan_reply_stats",
    sql: `
    /* Конверсия "фан ответил на приветку": считается фоновым воркером (не на
       чтении отчёта — OM API отдаёт 1 запрос/сек, вживую это было бы слишком
       медленно). Воркер постепенно обходит фанов через
       GET /chats/{fan_id}/messages и кладёт результат сюда; виджет в дашборде
       просто читает готовые строки. */
    CREATE TABLE IF NOT EXISTS fan_reply_stats (
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      of_fan_id TEXT NOT NULL,
      has_greeting INTEGER NOT NULL DEFAULT 0,
      replied INTEGER NOT NULL DEFAULT 0,
      reply_seconds REAL,
      om_error INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (link_id, of_fan_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fan_reply_stats_checked ON fan_reply_stats(checked_at);
    `,
  },
  {
    id: "008_partner_type_permissions",
    sql: `
    /* Пермишен на видимость партнёров по типу (External / In-house), на почту.
       По умолчанию оба включены — правки в "Доступ" не режут видимость
       никому, пока админ явно не выключит галочку. */
    ALTER TABLE allowed_emails ADD COLUMN can_see_external INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE allowed_emails ADD COLUMN can_see_inhouse INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN can_see_external INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN can_see_inhouse INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    id: "009_link_baseline_totals",
    sql: `
    /* Тотал кликов/фанов на ссылке в OM на момент её привязки в Глоссарии —
       чтобы сразу было видно, что ссылка не с нуля (была история до нас), а
       не выглядело потом как расхождение/баг в сверке дневных снимков. */
    ALTER TABLE links ADD COLUMN baseline_clicks INTEGER;
    ALTER TABLE links ADD COLUMN baseline_fans INTEGER;
    ALTER TABLE links ADD COLUMN baseline_captured_at TEXT;
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
