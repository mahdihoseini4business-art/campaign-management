-- CARNO offline SQLite schema (mirrors online backup tables + local deletion_log)
-- Bump offline-app/db/schema-version.txt when making breaking changes.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY NOT NULL,
  platform_id TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'instagram',
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  phones TEXT NOT NULL DEFAULT '[]',
  addresses TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT NOT NULL DEFAULT '',
  advisor TEXT NOT NULL DEFAULT '',
  advisor_phone TEXT NOT NULL DEFAULT '',
  next_followup_date TEXT NOT NULL DEFAULT '',
  products TEXT NOT NULL DEFAULT '[]',
  customer_level TEXT NOT NULL DEFAULT '',
  customer_level_locked INTEGER NOT NULL DEFAULT 0,
  referred_by_phone TEXT NOT NULL DEFAULT '',
  customer_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_customers_advisor_phone ON customers (advisor_phone);
CREATE INDEX IF NOT EXISTS idx_customers_updated_at ON customers (updated_at);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY,
  customer_id TEXT NOT NULL,
  date TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  next_date TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by_phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  done_at TEXT,
  done_by_phone TEXT NOT NULL DEFAULT '',
  done_note TEXT NOT NULL DEFAULT '',
  was_overdue INTEGER NOT NULL DEFAULT 0,
  assigned_to_phone TEXT,
  assigned_by_phone TEXT,
  assigned_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_followups_customer_id ON followups (customer_id);
CREATE INDEX IF NOT EXISTS idx_followups_updated_at ON followups (updated_at);
CREATE INDEX IF NOT EXISTS idx_followups_assigned_to_phone ON followups (assigned_to_phone);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  customer_id TEXT NOT NULL,
  product_index INTEGER NOT NULL DEFAULT 0,
  product_name TEXT NOT NULL DEFAULT '',
  payment_id TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  is_full_payment INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'requested',
  note TEXT NOT NULL DEFAULT '',
  refund_reason TEXT NOT NULL DEFAULT '',
  account_info TEXT NOT NULL DEFAULT '',
  account_holder_name TEXT NOT NULL DEFAULT '',
  sheba TEXT NOT NULL DEFAULT '',
  card_number TEXT NOT NULL DEFAULT '',
  reject_reason TEXT NOT NULL DEFAULT '',
  advisor_phone TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  created_by_phone TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  updated_by_phone TEXT NOT NULL DEFAULT '',
  completed_by_phone TEXT NOT NULL DEFAULT '',
  requested_at TEXT,
  awaiting_at TEXT,
  completed_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds (status);
CREATE INDEX IF NOT EXISTS idx_refunds_customer_id ON refunds (customer_id);
CREATE INDEX IF NOT EXISTS idx_refunds_updated_at ON refunds (updated_at);

CREATE TABLE IF NOT EXISTS ownership_transfers (
  id INTEGER PRIMARY KEY,
  customer_id TEXT NOT NULL,
  customer_phone TEXT NOT NULL DEFAULT '',
  from_advisor_phone TEXT,
  from_advisor_name TEXT,
  to_advisor_phone TEXT,
  to_advisor_name TEXT,
  acted_by_phone TEXT,
  batch_id TEXT,
  reason TEXT,
  customer_status_at_transfer TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ownership_transfers_customer_id ON ownership_transfers (customer_id);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_updated_at ON ownership_transfers (updated_at);

CREATE TABLE IF NOT EXISTS ownership_transfer_acks (
  id INTEGER PRIMARY KEY,
  user_phone TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_phone, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_ownership_transfer_acks_user ON ownership_transfer_acks (user_phone);

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  permissions TEXT NOT NULL DEFAULT '{}',
  password_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_phone TEXT NOT NULL,
  is_manager INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, user_phone),
  UNIQUE (user_phone),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  recipient_phones TEXT NOT NULL DEFAULT '[]',
  created_by_phone TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at);

CREATE TABLE IF NOT EXISTS notification_reads (
  user_phone TEXT NOT NULL,
  notification_id INTEGER NOT NULL,
  read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_phone, notification_id),
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deletion_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_by_phone TEXT
);

CREATE INDEX IF NOT EXISTS idx_deletion_log_table ON deletion_log (table_name);
