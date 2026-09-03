-- Migration 0007 — M2B: account reconciliation history
-- Forward-only. Never rewrite migrations 0001–0006.
--
-- This migration adds the reconciliation history table for M2B. A
-- reconciliation is an auditable record comparing a bank-confirmed
-- balance to the cleared ledger balance for an active account, with
-- an explicit, deterministic difference.
--
-- SPEC §7 reconciliation rules:
--   - Reconciliation compares bank-confirmed balance with cleared ledger
--     balance. A non-zero difference is displayed and never silently
--     repaired by inserting an adjustment.
--   - Different currencies are never aggregated; the account's
--     currency_code is FK'd to currencies and stored on each reconciliation
--     row as an audit snapshot.
--
-- Money policy: all monetary columns are INTEGER minor units (e.g. centavos
-- for PHP where minor_unit_scale = 2). No floating point anywhere.
--
-- Idempotency: idempotency_key is UNIQUE — the race-safe boundary for
-- retry protection. A retried reconciliation with the same immutable
-- request identity returns the existing record (created=false); a retried
-- reconciliation with a DIFFERENT payload surfaces as IDEMPOTENCY_CONFLICT
-- at the service layer (silently returning the prior record on a
-- conflicting payload would hide a client bug and break audit traceability).
--
-- Immutability / history: reconciliation records are append-only.
-- cleared_balance_minor and difference_minor are stored at write time as
-- a snapshot so historical audit reflects what was true at the moment of
-- confirmation, even if later ledger entries are posted against the same
-- account.

-- ── Account reconciliations (SPEC §7) ────────────────────────────────────────
-- bank_confirmed_balance_minor: the user-reported bank balance in integer
--   minor units of the account's currency.
-- cleared_balance_minor: opening_balance + SUM(ledger_entries.amount × sign)
--   in the account's currency, computed deterministically at write time
--   and stored as an immutable snapshot.
-- difference_minor: bank_confirmed - cleared; can be 0, positive or
--   negative; never silently absorbed into an adjustment transaction.
-- confirmed_at: ISO-8601 datetime ("YYYY-MM-DDTHH:MM:SS.sssZ") at which
--   the bank-confirmed balance was reported.
-- evidence_ref: optional synthetic evidence reference (R2 object key
--   placeholder; never a real path in this public repo).
CREATE TABLE IF NOT EXISTS account_reconciliations (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id                  INTEGER NOT NULL REFERENCES accounts(id),
  member_id                   INTEGER NOT NULL REFERENCES household_members(id),
  currency_code               TEXT    NOT NULL REFERENCES currencies(code),
  bank_confirmed_balance_minor INTEGER NOT NULL,
  cleared_balance_minor       INTEGER NOT NULL,
  difference_minor            INTEGER NOT NULL,
  confirmed_at                TEXT    NOT NULL,
  evidence_ref                TEXT,
  idempotency_key             TEXT    NOT NULL UNIQUE,
  created_at                  TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at                  TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_account_reconciliations_account_id
  ON account_reconciliations (account_id);
CREATE INDEX IF NOT EXISTS idx_account_reconciliations_member_id
  ON account_reconciliations (member_id);
CREATE INDEX IF NOT EXISTS idx_account_reconciliations_confirmed_at
  ON account_reconciliations (confirmed_at);

-- ── Record this migration ────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (7, '0007_account_reconciliations');
