-- Migration 0003 — Term-deposit persistence foundation (M1A)
-- Forward-only. Never rewrite migrations 0001 or 0002.
--
-- Money policy: all monetary columns are INTEGER minor units
--   (e.g. centavos for PHP, where minor_unit_scale = 2 in the `currencies` table).
-- Rate policy: rates are stored as integer × RATE_SCALE (= 1_000_000):
--   annual_rate_scaled = annual_rate * 1_000_000   (e.g. 5% -> 5_000_000)
--   tax_rate_scaled   = tax_rate   * 1_000_000   (e.g. 20% -> 200_000)
-- The scale is fixed at 1_000_000 and is documented in `src/domain/term-deposit/types.ts`.
-- Certificate numbers: only the last four ASCII digits are stored, never the full number.

-- ── term_deposits ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS term_deposits (
  id                               INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Linkage to M0 entities. The linked account is expected to be of
  -- account_type = 'TERM_DEPOSIT'; business code, not DDL, enforces that.
  account_id                       INTEGER NOT NULL REFERENCES accounts(id),
  bank_id                          INTEGER NOT NULL REFERENCES banks(id),
  holder_member_id                 INTEGER NOT NULL REFERENCES household_members(id),
  currency_code                    TEXT    NOT NULL REFERENCES currencies(code),

  -- Identification
  product_name                     TEXT    NOT NULL,
  nickname                         TEXT,
  -- Exactly four ASCII digits. The full certificate number is never stored.
  certificate_last_four            TEXT    NOT NULL
                                     CHECK (
                                       length(certificate_last_four) = 4
                                       AND certificate_last_four GLOB '[0-9][0-9][0-9][0-9]'
                                     ),

  -- Financial facts (integer minor units / scaled integer rates)
  principal_minor                  INTEGER NOT NULL CHECK (principal_minor >= 0),
  start_date                       TEXT    NOT NULL,   -- ISO 'YYYY-MM-DD'
  maturity_date                    TEXT    NOT NULL,   -- ISO 'YYYY-MM-DD'
  annual_rate_scaled               INTEGER NOT NULL CHECK (annual_rate_scaled >= 0),
  tax_rate_scaled                  INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_scaled >= 0),
  fees_minor                       INTEGER NOT NULL DEFAULT 0 CHECK (fees_minor >= 0),

  -- Calculation method
  interest_method                  TEXT    NOT NULL
                                     CHECK (interest_method IN ('SIMPLE', 'COMPOUND')),
  day_count_basis                  TEXT    NOT NULL
                                     CHECK (day_count_basis IN ('ACT_365', 'ACT_360', 'ACT_ACT')),

  -- State machine (SPEC §4.2)
  state                           TEXT    NOT NULL DEFAULT 'DRAFT'
                                     CHECK (state IN (
                                       'DRAFT',
                                       'REVIEW_REQUIRED',
                                       'ACTIVE',
                                       'MATURED_ACTION_REQUIRED',
                                       'SETTLED_TO_ACCOUNT',
                                       'RENEWED',
                                       'PRETERMINATED',
                                       'CANCELLED'
                                     )),

  -- Optional bank-quoted contractual facts. Informational only; do NOT mutate the
  -- deterministic system estimate algorithm. Used for cross-checking, not substitution.
  bank_quoted_gross_interest_minor   INTEGER CHECK (bank_quoted_gross_interest_minor >= 0),
  bank_quoted_net_interest_minor     INTEGER CHECK (bank_quoted_net_interest_minor >= 0),
  bank_quoted_maturity_amount_minor  INTEGER CHECK (bank_quoted_maturity_amount_minor >= 0),

  -- Maturity instruction (planned action; the actual closure transitions are gated)
  maturity_instruction            TEXT    NOT NULL DEFAULT 'PENDING'
                                     CHECK (maturity_instruction IN (
                                       'SETTLE_TO_ACCOUNT',
                                       'RENEW',
                                       'PRETERMINATE',
                                       'PENDING'
                                     )),
  maturity_settlement_account_id  INTEGER REFERENCES accounts(id),

  -- Predecessor / successor linkage (renewals)
  predecessor_deposit_id          INTEGER REFERENCES term_deposits(id),
  successor_deposit_id            INTEGER REFERENCES term_deposits(id),

  -- Source / settlement evidence references (opaque application-controlled keys)
  source_evidence_ref             TEXT,
  settlement_evidence_ref         TEXT,

  -- Timestamps
  created_at                      TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at                      TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),

  CHECK (maturity_date >= start_date),
  CHECK (predecessor_deposit_id IS NULL OR predecessor_deposit_id <> id),
  CHECK (successor_deposit_id IS NULL OR successor_deposit_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_term_deposits_account_id
  ON term_deposits (account_id);
CREATE INDEX IF NOT EXISTS idx_term_deposits_state
  ON term_deposits (state);
CREATE INDEX IF NOT EXISTS idx_term_deposits_maturity_date
  ON term_deposits (maturity_date);
CREATE INDEX IF NOT EXISTS idx_term_deposits_holder_member_id
  ON term_deposits (holder_member_id);

-- ── Record this migration ─────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (3, '0003_term_deposits');
