PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glossary_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  telegram TEXT,
  type TEXT,
  source TEXT,
  monthly_fee REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  creator TEXT NOT NULL,
  campaign_code TEXT NOT NULL,
  of_url TEXT NOT NULL UNIQUE,
  cpf_free REAL,
  cpf_paid REAL,
  revshare_pct REAL,
  source TEXT,

  of_account_id TEXT,
  of_tracking_link_id INTEGER,
  of_created_at TEXT,

  clicks_count INTEGER,
  subscribers_count INTEGER,
  spenders_count INTEGER,
  revenue_total REAL,
  revenue_per_click REAL,
  revenue_per_subscriber REAL,
  last_synced_at TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_links_partner ON links(partner_id);
CREATE INDEX IF NOT EXISTS idx_links_of_url ON links(of_url);
CREATE INDEX IF NOT EXISTS idx_links_creator ON links(creator);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  clicks_count INTEGER,
  subscribers_count INTEGER,
  spenders_count INTEGER,
  revenue_total REAL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_link_ts ON snapshots(link_id, ts);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT,
  items_processed INTEGER,
  error TEXT
);

/* ===== Кэш per-link фанов: загружается лениво при открытии drill-down ===== */
CREATE TABLE IF NOT EXISTS link_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  of_fan_id TEXT NOT NULL,
  username TEXT,
  subscribed_at TEXT,
  is_active INTEGER,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(link_id, of_fan_id)
);
CREATE INDEX IF NOT EXISTS idx_link_subs_link ON link_subscribers(link_id);

CREATE TABLE IF NOT EXISTS link_spenders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  of_fan_id TEXT NOT NULL,
  username TEXT,
  revenue_total REAL NOT NULL DEFAULT 0,
  calculated_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(link_id, of_fan_id)
);
CREATE INDEX IF NOT EXISTS idx_link_spenders_link ON link_spenders(link_id);

/* ===== Chargebacks, transactions, payouts — синкаются периодически ===== */
CREATE TABLE IF NOT EXISTS chargebacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  of_account_id TEXT NOT NULL,
  of_id TEXT,
  fan_id TEXT,
  fan_username TEXT,
  amount REAL,
  currency TEXT,
  reason TEXT,
  status TEXT,
  occurred_at TEXT,
  resolved_at TEXT,
  raw_json TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(of_account_id, of_id)
);
CREATE INDEX IF NOT EXISTS idx_cb_account ON chargebacks(of_account_id);
CREATE INDEX IF NOT EXISTS idx_cb_fan ON chargebacks(fan_id);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  of_account_id TEXT NOT NULL,
  of_id TEXT,
  fan_id TEXT,
  fan_username TEXT,
  amount REAL,
  net REAL,
  currency TEXT,
  type TEXT,
  description TEXT,
  occurred_at TEXT,
  raw_json TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(of_account_id, of_id)
);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(of_account_id);
CREATE INDEX IF NOT EXISTS idx_tx_fan ON transactions(fan_id);
CREATE INDEX IF NOT EXISTS idx_tx_occurred ON transactions(occurred_at);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  of_account_id TEXT NOT NULL,
  of_id TEXT,
  amount REAL,
  net REAL,
  currency TEXT,
  status TEXT,
  requested_at TEXT,
  paid_at TEXT,
  raw_json TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(of_account_id, of_id)
);
CREATE INDEX IF NOT EXISTS idx_payout_account ON payouts(of_account_id);

/* ===== Webhook events — журнал всех входящих событий от OF API ===== */
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  of_account_id TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_wh_received ON webhook_events(received_at);
CREATE INDEX IF NOT EXISTS idx_wh_type ON webhook_events(event_type);
