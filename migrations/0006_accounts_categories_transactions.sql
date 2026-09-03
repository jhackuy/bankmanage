-- Migration 0006 — M2A: accounts, categories/favorites, transactions, balanced ledger (M2A slice)
-- Forward-only. Never rewrite migrations 0001–0005.
--
-- This migration adds the data layer for M2A. It does NOT change the existing
-- `accounts` table from migration 0001; that schema already covers SPEC §3
-- requirements (account_type including INTERNAL, opening_balance_minor,
-- active/archived flags, FK to currencies/banks/household_members).
--
-- Money policy: all monetary columns are INTEGER minor units (e.g. centavos
-- for PHP where minor_unit_scale = 2). No floating point anywhere.
--
-- Idempotency: every posted transaction has a UNIQUE idempotency_key so
-- retried calls cannot double-post a financial fact.
--
-- Immutability: transactions are never physically deleted. Corrections go
-- through a balanced reversal recorded in `transaction_reversals`. The
-- UNIQUE constraints on (original_transaction_id) and (reversal_transaction_id)
-- are the race-safe boundary that prevents reversing the same transaction
-- twice or linking the same reversal to two originals.
--
-- Balanced entry policy: `ledger_entries` rows reference EITHER an account
-- OR a category (one is required, one is null). For each transaction the
-- application enforces SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) = 0
-- within a single currency. Schema enforces exactly-one of {account_id,
-- category_id}.

-- ── Per-member category favorites (SPEC §6.1 — "rise to the front") ─────────
-- Frequently used categories should rise above less-used ones. The favorites
-- table stores a per-member sort_order, use_count and last_used_at; the
-- application derives the effective sort order from these fields. Categories
-- table rows are the authoritative existence; this table is a derived index.
CREATE TABLE IF NOT EXISTS account_category_favorites (
  member_id    INTEGER NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  use_count    INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  last_used_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  PRIMARY KEY (member_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_account_category_favorites_member_sort
  ON account_category_favorites (member_id, sort_order);

-- ── Per-member account favorites (SPEC §6.1) ────────────────────────────────
-- Same model as categories; accounts that a member uses frequently rise to
-- the top of the SIMPLE UI without opaque automation.
CREATE TABLE IF NOT EXISTS account_favorites (
  member_id    INTEGER NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  use_count    INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  last_used_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  PRIMARY KEY (member_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_account_favorites_member_sort
  ON account_favorites (member_id, sort_order);

-- ── Transactions (header) ────────────────────────────────────────────────────
-- transaction_type: INCOME | EXPENSE | TRANSFER.
--   INCOME   — money enters a user's account; the offset side is a category.
--   EXPENSE  — money leaves a user's account; the offset side is a category.
--   TRANSFER — money moves between two user accounts (same currency).
-- currency_code: the currency this transaction lives in. Every ledger
--   entry's currency_code must equal this value; cross-currency postings
--   are rejected unless a future explicit FX workflow exists.
-- amount_minor: positive safe integer minor units. Negative or zero values
--   would break the balanced invariant.
-- state: 'POSTED' or 'REVERSED'. Reversal is a service-level operation
--   that creates a balanced counter-transaction; the original is marked
--   REVERSED rather than physically deleted (SPEC §7).
-- idempotency_key: UNIQUE race-safe boundary. The application service
--   rejects a duplicate key by returning the existing transaction, so a
--   retried call cannot double-post.
CREATE TABLE IF NOT EXISTS transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id           INTEGER NOT NULL REFERENCES household_members(id),
  transaction_type    TEXT    NOT NULL CHECK (transaction_type IN ('INCOME', 'EXPENSE', 'TRANSFER')),
  currency_code       TEXT    NOT NULL REFERENCES currencies(code),
  amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),
  occurred_on         TEXT    NOT NULL,                  -- ISO 'YYYY-MM-DD'
  description         TEXT,
  idempotency_key     TEXT    NOT NULL UNIQUE,
  state               TEXT    NOT NULL DEFAULT 'POSTED' CHECK (state IN ('POSTED', 'REVERSED')),
  source_evidence_ref TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_member_id
  ON transactions (member_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type
  ON transactions (transaction_type);
CREATE INDEX IF NOT EXISTS idx_transactions_occurred_on
  ON transactions (occurred_on);
CREATE INDEX IF NOT EXISTS idx_transactions_state
  ON transactions (state);

-- ── Ledger entries (balanced within a single currency per transaction) ───────
-- Each transaction has 2 entries (one DEBIT, one CREDIT) that sum to zero
-- within the transaction's currency_code. The CHECK constraint enforces
-- exactly-one of {account_id, category_id}: account-side entries reference
-- a real account; category-side entries reference an expense or income
-- category and never reference an account. This makes TRANSFER entries
-- structurally distinct from INCOME/EXPENSE: TRANSFER has TWO account-side
-- entries, INCOME/EXPENSE each have exactly ONE account-side entry and ONE
-- category-side entry — so a TRANSFER can never be counted as income or
-- expense by accident.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  account_id     INTEGER          REFERENCES accounts(id),
  category_id    INTEGER          REFERENCES categories(id),
  direction      TEXT    NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  currency_code  TEXT    NOT NULL REFERENCES currencies(code),
  memo           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  -- Exactly one of account_id, category_id must be set. The XOR
  -- constraint rejects both-null and both-set rows at INSERT/UPDATE time.
  CHECK ((account_id IS NOT NULL) <> (category_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction_id
  ON ledger_entries (transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_id
  ON ledger_entries (account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_category_id
  ON ledger_entries (category_id);

-- ── Reversal traceability (SPEC §7) ──────────────────────────────────────────
-- Posted transactions are immutable financial facts. Corrections use
-- void/reversal semantics. Each reversal:
--   - links to exactly one original (UNIQUE on original_transaction_id);
--   - is itself a balanced transaction (UNIQUE on reversal_transaction_id);
--   - records who reversed it, when, and an optional reason.
-- The UNIQUE constraint on original_transaction_id is the race-safe
-- idempotency boundary: two concurrent reversal attempts on the same
-- original produce exactly one row.
CREATE TABLE IF NOT EXISTS transaction_reversals (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  original_transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
  reversal_transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
  reason                  TEXT,
  reversed_by_member_id   INTEGER NOT NULL REFERENCES household_members(id),
  reversed_at             TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_transaction_reversals_original
  ON transaction_reversals (original_transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_reversals_reversal
  ON transaction_reversals (reversal_transaction_id);

-- ── Record this migration ────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (6, '0006_accounts_categories_transactions');