-- Migration 0001 — Foundation entities
-- Creates the minimum schema needed for M0–M4.
-- All money values stored as INTEGER minor units (e.g. centavos for PHP).
-- Apply in order; never modify an existing migration; add new ones instead.

-- ── Migration metadata ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migration_metadata (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

-- ── Household members (Telegram-identity based, exactly two for pilot) ────────
CREATE TABLE IF NOT EXISTS household_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role        TEXT    NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
  display_name TEXT   NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

-- ── Telegram identities (linked 1:1 to household_members) ────────────────────
-- telegram_id is the real numeric Telegram user ID (stored as TEXT to avoid
-- 64-bit integer precision issues in SQLite and JS).
-- Stored here rather than inline in household_members so the identity model
-- can evolve independently of the business member model.
CREATE TABLE IF NOT EXISTS telegram_identities (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id        INTEGER NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  telegram_user_id TEXT    NOT NULL UNIQUE,   -- numeric Telegram user ID as string
  created_at       TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_telegram_identities_user_id
  ON telegram_identities (telegram_user_id);

-- ── Currencies ────────────────────────────────────────────────────────────────
-- minor_unit_scale: number of decimal places (e.g. 2 for PHP → centavos)
CREATE TABLE IF NOT EXISTS currencies (
  code             TEXT    PRIMARY KEY CHECK (length(code) = 3),
  name             TEXT    NOT NULL,
  minor_unit_scale INTEGER NOT NULL DEFAULT 2 CHECK (minor_unit_scale >= 0),
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

-- ── Banks (configuration data, not an enum — extensible without code changes) ─
-- slug: machine-safe identifier (lowercase, hyphens), used in code/queries.
-- is_system: 1 = seeded by migration, 0 = user-added custom bank.
CREATE TABLE IF NOT EXISTS banks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  short_name  TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

-- ── Accounts ──────────────────────────────────────────────────────────────────
-- account_type: BANK | CASH | E_WALLET | CREDIT_CARD | TERM_DEPOSIT | INTERNAL
-- opening_balance_minor: integer minor units in the account's currency.
-- Different currencies must never be silently summed 1:1.
CREATE TABLE IF NOT EXISTS accounts (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id              INTEGER NOT NULL REFERENCES household_members(id),
  bank_id                INTEGER REFERENCES banks(id),
  currency_code          TEXT    NOT NULL REFERENCES currencies(code),
  account_type           TEXT    NOT NULL CHECK (account_type IN (
                           'BANK', 'CASH', 'E_WALLET', 'CREDIT_CARD', 'TERM_DEPOSIT', 'INTERNAL'
                         )),
  nickname               TEXT    NOT NULL,
  opening_balance_minor  INTEGER NOT NULL DEFAULT 0,
  active                 INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived               INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  last_reconciled_at     TEXT,
  created_at             TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at             TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_member_id ON accounts (member_id);
CREATE INDEX IF NOT EXISTS idx_accounts_bank_id ON accounts (bank_id);

-- ── Expense categories ────────────────────────────────────────────────────────
-- parent_id: supports optional subcategories.
-- sort_order: controls the order shown in the UI without requiring re-sorting.
-- is_system: 1 = seeded by migration (default household categories).
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id   INTEGER REFERENCES categories(id),
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

-- ── Seed currencies ───────────────────────────────────────────────────────────
INSERT OR IGNORE INTO currencies (code, name, minor_unit_scale) VALUES
  ('PHP', 'Philippine Peso',   2),
  ('USD', 'US Dollar',         2),
  ('EUR', 'Euro',              2),
  ('SGD', 'Singapore Dollar',  2),
  ('JPY', 'Japanese Yen',      0);

-- ── Seed banks (BDO, BPI, Metrobank, PNB, HSBC, Other/custom boundary) ────────
INSERT OR IGNORE INTO banks (slug, name, short_name, is_system) VALUES
  ('bdo',        'Banco de Oro Unibank',              'BDO',       1),
  ('bpi',        'Bank of the Philippine Islands',    'BPI',       1),
  ('metrobank',  'Metropolitan Bank and Trust Co.',   'Metrobank', 1),
  ('pnb',        'Philippine National Bank',          'PNB',       1),
  ('hsbc',       'HSBC Philippines',                  'HSBC',      1),
  ('other',      'Other / Custom Bank',               'Other',     1);

-- ── Seed household expense categories ─────────────────────────────────────────
INSERT OR IGNORE INTO categories (slug, name, sort_order, is_system) VALUES
  ('household-salary-nanny',   'Nanny / House Helper Salary', 10, 1),
  ('household-salary-driver',  'Driver Salary',               20, 1),
  ('household-repair',         'House Repair',                30, 1),
  ('household-maintenance',    'Home Maintenance',            40, 1),
  ('household-pool',           'Pool Cleaning / Maintenance', 50, 1),
  ('groceries',                'Groceries / Wet Market',      60, 1),
  ('household-supplies',       'Household Supplies',          70, 1),
  ('utilities-electricity',    'Electricity',                 80, 1),
  ('utilities-water',          'Water',                       90, 1),
  ('utilities-internet',       'Internet / Mobile',          100, 1),
  ('transport-fuel',           'Fuel',                       110, 1),
  ('transport-parking',        'Parking / Tolls',            120, 1),
  ('dining',                   'Dining',                     130, 1),
  ('children-school',          'Children / School',          140, 1),
  ('medical',                  'Medical',                    150, 1),
  ('pet',                      'Pet',                        160, 1),
  ('entertainment',            'Entertainment',              170, 1),
  ('travel',                   'Travel',                     180, 1),
  ('tips-cash',                'Tips / Small Cash Expense',  190, 1),
  ('other',                    'Other',                      999, 1);

-- ── Record this migration ─────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (1, '0001_foundation');
