-- Migration 0017 — M3C: atomic settlement-closure boundary
-- Forward-only. Never rewrite migrations 0001–0016.
--
-- This migration provides the single atomic database command that finalizes
-- a SETTLEMENT review session and writes the complete balanced ledger bundle
-- for a matured term deposit's closure.
--
-- SPEC §4.2 / §6.2 / §12 contract enforced here:
--   - "If SETTLED_TO_ACCOUNT or PRETERMINATED: select the settlement account;
--      capture settlement/credit evidence; confirm actual settlement date,
--      actual received total, interest, tax, penalty/fees as applicable;
--      create balanced ledger entries; only then may the old deposit enter a
--      terminal state."
--   - "Failure anywhere in a financial closure must cause zero partial
--      financial state."
--   - OCR/vision output never directly posts a financial transaction. The
--      application service that wraps this boundary must source the
--      confirmed amounts from the user-confirmed payload only.
--
-- Atomic boundary design:
--   A single INSERT INTO settlement_closures is the closure command. A
--   BEFORE INSERT trigger validates every precondition and the integer
--   reconciliation; an AFTER INSERT trigger finalizes the deposit state,
--   evidence, and review session. The caller wraps the full closure
--   sequence (ledger bundle INSERTs + settlement_closures INSERT) in a
--   single transaction (D1 db.batch / better-sqlite3 db.transaction), so
--   any RAISE(ABORT) from the trigger rolls back the entire bundle with
--   zero partial financial mutation.
--
-- Idempotency boundary:
--   settlement_closures.idempotency_key is UNIQUE. The deterministic
--   derived transaction idempotency keys
--     settlement-principal:<key>, settlement-interest:<key>,
--     settlement-tax:<key>, settlement-penalty:<key>
--   are UNIQUE on transactions. A same-key retry collides on UNIQUE and
--   the entire batch rolls back, preserving the canonical persisted
--   closure from the first successful attempt.

-- ── categories.category_type (minimum system categories needed) ───────────────
-- The 0001 categories table has no category_type column. We add it now so
-- the minimum INCOME / EXPENSE system categories can be seeded for the
-- settlement ledger bundle. Existing categories default to 'NEITHER' and
-- remain functionally unchanged for the existing flows.
ALTER TABLE categories ADD COLUMN category_type TEXT NOT NULL DEFAULT 'NEITHER'
  CHECK (category_type IN ('INCOME', 'EXPENSE', 'NEITHER'));

-- ── Minimum system categories for settlement closure ─────────────────────────
-- These are the only three categories the closure boundary needs; the
-- caller references them by slug when building the ledger bundle. All
-- three are is_system=1 and idempotent on re-apply via INSERT OR IGNORE.
INSERT OR IGNORE INTO categories (slug, name, icon, sort_order, is_system, active, category_type) VALUES
  ('interest-income',      'Term Deposit Interest Income',    'bank',  310, 1, 1, 'INCOME'),
  ('withholding-tax',      'Withholding Tax on Interest',     'tax',   320, 1, 1, 'EXPENSE'),
  ('early-termination',    'Early Termination Penalty/Fees', 'alert', 330, 1, 1, 'EXPENSE');

-- ── term_deposits.settlement_closure_id (audit back-link) ────────────────────
-- The AFTER trigger on settlement_closures sets this column to the new
-- closure's id. Nullable: non-SETTLED_TO_ACCOUNT deposits have no closure.
ALTER TABLE term_deposits ADD COLUMN settlement_closure_id INTEGER REFERENCES settlement_closures(id);

-- ── settlement_closures (audit table for the closure command) ────────────────
-- One row per canonical closure. The idempotency_key is the same key the
-- caller used to claim the review session's post slot; the BEFORE trigger
-- enforces that the session is PENDING_REVIEW, SETTLEMENT, linked to the
-- deposit, and its post_idempotency_key matches.
CREATE TABLE IF NOT EXISTS settlement_closures (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key                 TEXT    NOT NULL UNIQUE,

  review_session_id               INTEGER NOT NULL REFERENCES review_sessions(id),
  deposit_id                      INTEGER NOT NULL REFERENCES term_deposits(id),
  document_id                     INTEGER NOT NULL REFERENCES documents(id),
  confirming_member_id            INTEGER NOT NULL REFERENCES household_members(id),
  settlement_account_id           INTEGER NOT NULL REFERENCES accounts(id),
  currency_code                   TEXT    NOT NULL REFERENCES currencies(code),

  -- Settlement facts (integer minor units). All non-negative by CHECK.
  principal_minor                 INTEGER NOT NULL CHECK (principal_minor >= 0),
  gross_interest_minor            INTEGER NOT NULL CHECK (gross_interest_minor >= 0),
  tax_minor                       INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  penalty_fees_minor              INTEGER NOT NULL DEFAULT 0 CHECK (penalty_fees_minor >= 0),
  received_total_minor            INTEGER NOT NULL CHECK (received_total_minor >= 0),
  actual_settlement_date          TEXT    NOT NULL CHECK (
    date(actual_settlement_date) = actual_settlement_date
  ),

  -- Canonical ledger linkage. The principal transfer is the audit anchor
  -- for the SETTLED_TO_ACCOUNT transition and for the review_sessions
  -- .linked_transaction_id link. The caller derives the transaction id
  -- via a subquery on the deterministic transaction idempotency key.
  principal_transfer_transaction_id INTEGER NOT NULL REFERENCES transactions(id),

  created_at                      TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_closures_session
  ON settlement_closures (review_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_closures_deposit
  ON settlement_closures (deposit_id);
CREATE INDEX IF NOT EXISTS idx_settlement_closures_confirming_member_id
  ON settlement_closures (confirming_member_id);

-- Audit back-link: at most one closure per deposit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_term_deposits_settlement_closure_id
  ON term_deposits (settlement_closure_id);

-- ── BEFORE INSERT trigger: precondition + reconciliation gate ───────────────
-- Each SELECT RAISE(ABORT, …) is conditional on its precondition failing.
-- RAISE(ABORT) aborts the current statement; since the caller wraps the
-- full closure batch in a single SQLite transaction, the abort rolls the
-- entire bundle back with zero partial financial mutation.
CREATE TRIGGER IF NOT EXISTS trg_settlement_closures_validate
BEFORE INSERT ON settlement_closures
FOR EACH ROW
BEGIN
  -- (1) Session must be PENDING_REVIEW, SETTLEMENT, linked to this deposit,
  --     bound to the same document, and its post_idempotency_key must equal
  --     the closure idempotency_key.
  SELECT RAISE(ABORT, 'settlement_closure: review session precondition failed')
  WHERE NOT EXISTS (
    SELECT 1
    FROM review_sessions rs
    WHERE rs.id = NEW.review_session_id
      AND rs.kind = 'SETTLEMENT'
      AND rs.status = 'PENDING_REVIEW'
      AND rs.deposit_id = NEW.deposit_id
      AND rs.document_id = NEW.document_id
      AND rs.post_idempotency_key IS NOT NULL
      AND rs.post_idempotency_key = NEW.idempotency_key
  );

  -- (2) Closure principal_minor and currency_code must match the deposit.
  SELECT RAISE(ABORT, 'settlement_closure: deposit principal/currency mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM term_deposits td
    WHERE td.id = NEW.deposit_id
      AND td.principal_minor = NEW.principal_minor
      AND td.currency_code = NEW.currency_code
  );

  -- (3) Deposit must be in the exact closure-eligible state.
  SELECT RAISE(ABORT, 'settlement_closure: deposit state precondition failed')
  WHERE NOT EXISTS (
    SELECT 1
    FROM term_deposits td
    WHERE td.id = NEW.deposit_id
      AND td.state = 'MATURED_ACTION_REQUIRED'
  );

  -- (4) Confirming member must be active OWNER.
  SELECT RAISE(ABORT, 'settlement_closure: confirming member not active OWNER')
  WHERE NOT EXISTS (
    SELECT 1
    FROM household_members hm
    WHERE hm.id = NEW.confirming_member_id
      AND hm.role = 'OWNER'
      AND hm.active = 1
  );

  -- (5) Source (deposit's account) and destination (settlement_account_id)
  --     must both be active, not archived, same currency, and the
  --     destination must belong to the confirming member.
  SELECT RAISE(ABORT, 'settlement_closure: account/currency precondition failed')
  WHERE NOT EXISTS (
    SELECT 1
    FROM term_deposits td
    JOIN accounts src ON src.id = td.account_id
    JOIN accounts dest ON dest.id = NEW.settlement_account_id
    WHERE td.id = NEW.deposit_id
      AND src.active = 1
      AND src.archived = 0
      AND dest.active = 1
      AND dest.archived = 0
      AND src.currency_code = NEW.currency_code
      AND dest.currency_code = NEW.currency_code
      AND dest.member_id = NEW.confirming_member_id
  );

  -- (6) Integer reconciliation: received_total = principal + gross_interest
  --     - tax - penalty/fees. All values are integer minor units; no
  --     floating-point arithmetic, no rounding tolerance.
  SELECT RAISE(ABORT, 'settlement_closure: reconciliation precondition failed')
  WHERE NOT (
    NEW.received_total_minor
      = NEW.principal_minor + NEW.gross_interest_minor
        - NEW.tax_minor - NEW.penalty_fees_minor
  );

  -- (7) Document must exist and be SETTLEMENT_EVIDENCE.
  SELECT RAISE(ABORT, 'settlement_closure: document precondition failed')
  WHERE NOT EXISTS (
    SELECT 1
    FROM documents d
    WHERE d.id = NEW.document_id
      AND d.kind = 'SETTLEMENT_EVIDENCE'
      AND d.lifecycle_state = 'ACTIVE'
  );

  -- (8) Principal TRANSFER bundle: header, balanced source CREDIT and
  --     destination DEBIT (exactly two ledger entries, currency-matched).
  SELECT RAISE(ABORT, 'settlement_closure: principal transfer bundle invalid')
  WHERE NOT EXISTS (
    SELECT 1
    FROM transactions t
    JOIN term_deposits td ON td.id = NEW.deposit_id
    WHERE t.idempotency_key = 'settlement-principal:' || NEW.idempotency_key
      AND t.transaction_type = 'TRANSFER'
      AND t.amount_minor = NEW.principal_minor
      AND t.currency_code = NEW.currency_code
      AND (SELECT COALESCE(SUM(amount_minor), 0)
             FROM ledger_entries
            WHERE transaction_id = t.id
              AND account_id = td.account_id
              AND direction = 'CREDIT'
              AND currency_code = NEW.currency_code) = NEW.principal_minor
      AND (SELECT COALESCE(SUM(amount_minor), 0)
             FROM ledger_entries
            WHERE transaction_id = t.id
              AND account_id = NEW.settlement_account_id
              AND direction = 'DEBIT'
              AND currency_code = NEW.currency_code) = NEW.principal_minor
      AND (SELECT COUNT(*)
             FROM ledger_entries
            WHERE transaction_id = t.id) = 2
  );

  -- (9) Interest INCOME bundle: present iff gross_interest > 0; absent
  --     iff gross_interest = 0 (required-vs-zero component presence).
  SELECT RAISE(ABORT, 'settlement_closure: interest bundle missing')
  WHERE NEW.gross_interest_minor > 0
    AND NOT EXISTS (
      SELECT 1
      FROM transactions t
      WHERE t.idempotency_key = 'settlement-interest:' || NEW.idempotency_key
        AND t.transaction_type = 'INCOME'
        AND t.amount_minor = NEW.gross_interest_minor
        AND t.currency_code = NEW.currency_code
        AND (SELECT COALESCE(SUM(amount_minor), 0)
               FROM ledger_entries
              WHERE transaction_id = t.id
                AND account_id = NEW.settlement_account_id
                AND direction = 'DEBIT'
                AND currency_code = NEW.currency_code) = NEW.gross_interest_minor
        AND (SELECT COALESCE(SUM(amount_minor), 0)
               FROM ledger_entries
              WHERE transaction_id = t.id
                AND category_id = (SELECT id FROM categories WHERE slug = 'interest-income')
                AND direction = 'CREDIT'
                AND currency_code = NEW.currency_code) = NEW.gross_interest_minor
        AND (SELECT COUNT(*)
               FROM ledger_entries
              WHERE transaction_id = t.id) = 2
    );

  SELECT RAISE(ABORT, 'settlement_closure: interest bundle present when zero')
  WHERE NEW.gross_interest_minor = 0
    AND EXISTS (
      SELECT 1
      FROM transactions t
      WHERE t.idempotency_key = 'settlement-interest:' || NEW.idempotency_key
    );

  -- (10) Tax EXPENSE bundle: present iff tax > 0.
  SELECT RAISE(ABORT, 'settlement_closure: tax bundle missing')
  WHERE NEW.tax_minor > 0
    AND NOT EXISTS (
      SELECT 1
      FROM transactions t
      WHERE t.idempotency_key = 'settlement-tax:' || NEW.idempotency_key
        AND t.transaction_type = 'EXPENSE'
        AND t.amount_minor = NEW.tax_minor
        AND t.currency_code = NEW.currency_code
        AND (SELECT COALESCE(SUM(amount_minor), 0)
               FROM ledger_entries
              WHERE transaction_id = t.id
                AND account_id = NEW.settlement_account_id
                AND direction = 'CREDIT'
                AND currency_code = NEW.currency_code) = NEW.tax_minor
        AND (SELECT COALESCE(SUM(amount_minor), 0)
               FROM ledger_entries
              WHERE transaction_id = t.id
                AND category_id = (SELECT id FROM categories WHERE slug = 'withholding-tax')
                AND direction = 'DEBIT'
                AND currency_code = NEW.currency_code) = NEW.tax_minor
        AND (SELECT COUNT(*)
               FROM ledger_entries
              WHERE transaction_id = t.id) = 2
    );

  SELECT RAISE(ABORT, 'settlement_closure: tax bundle present when zero')
  WHERE NEW.tax_minor = 0
    AND EXISTS (
      SELECT 1
      FROM transactions t
      WHERE t.idempotency_key = 'settlement-tax:' || NEW.idempotency_key
    );

  -- (11) Penalty/fees EXPENSE bundle: present iff penalty > 0.
  SELECT RAISE(ABORT, 'settlement_closure: penalty bundle missing')
  WHERE NEW.penalty_fees_minor > 0
    AND NOT EXISTS (
      SELECT 1
      FROM transactions t
      WHERE t.idempotency_key = 'settlement-penalty:' || NEW.idempotency_key
        AND t.transaction_type = 'EXPENSE'
        AND t.amount_minor = NEW.penalty_fees_minor
        AND t.currency_code = NEW.currency_code
        AND (SELECT COALESCE(SUM(amount_minor), 0)
               FROM ledger_entries
              WHERE transaction_id = t.id
                AND account_id = NEW.settlement_account_id
                AND direction = 'CREDIT'
                AND currency_code = NEW.currency_code) = NEW.penalty_fees_minor
        AND (SELECT COALESCE(SUM(amount_minor), 0)
               FROM ledger_entries
              WHERE transaction_id = t.id
                AND category_id = (SELECT id FROM categories WHERE slug = 'early-termination')
                AND direction = 'DEBIT'
                AND currency_code = NEW.currency_code) = NEW.penalty_fees_minor
        AND (SELECT COUNT(*)
               FROM ledger_entries
              WHERE transaction_id = t.id) = 2
    );

  SELECT RAISE(ABORT, 'settlement_closure: penalty bundle present when zero')
  WHERE NEW.penalty_fees_minor = 0
    AND EXISTS (
      SELECT 1
      FROM transactions t
      WHERE t.idempotency_key = 'settlement-penalty:' || NEW.idempotency_key
    );
END;

-- ── AFTER INSERT trigger: finalize deposit + session ─────────────────────────
-- Runs only if every BEFORE trigger precondition passed. Sets the deposit
-- to its terminal SETTLED_TO_ACCOUNT state, writes the doc:<id> evidence
-- reference, and confirms the review session linked to the canonical
-- principal transfer transaction.
CREATE TRIGGER IF NOT EXISTS trg_settlement_closures_finalize
AFTER INSERT ON settlement_closures
FOR EACH ROW
BEGIN
  UPDATE term_deposits
     SET state                       = 'SETTLED_TO_ACCOUNT',
         settlement_evidence_ref     = 'doc:' || CAST(NEW.document_id AS TEXT),
         maturity_settlement_account_id = NEW.settlement_account_id,
         settlement_closure_id       = NEW.id,
         updated_at                  = datetime('now', 'utc')
   WHERE id = NEW.deposit_id;

  UPDATE review_sessions
     SET status                  = 'CONFIRMED',
         linked_transaction_id   = NEW.principal_transfer_transaction_id,
         updated_at              = datetime('now', 'utc')
   WHERE id = NEW.review_session_id;
END;

-- ── Record this migration ────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (17, '0017_settlement_closure_boundary');
