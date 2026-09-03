-- Migration 0008 — M2B: track caller's currency declaration on reconciliation rows
-- Forward-only. Never rewrite migrations 0001–0007.
--
-- The idempotency identity for a reconciliation must distinguish
-- "caller explicitly declared a currency" from "caller omitted the
-- currency". Without this signal, the stored row always carries the
-- account's currency (the service normalizes omitted input to the
-- account currency before insert — a requirement of the
-- currency_code NOT NULL + FK to currencies(code) constraint), making
-- it impossible to tell on retry whether the original caller provided
-- the currency or not.
--
-- The identity comparison needs to be symmetric so that:
--   - same-payload retries that omit currency return created=false
--     (no conflict) — tests for "same-payload retry",
--     "concurrent same-payload retry", and
--     "mixed-offset retries of the same instant";
--   - retries where the first call provided a currency and the second
--     omits it surface IDEMPOTENCY_CONFLICT — the test contract for
--     "currencyCode is part of the idempotency identity".
--
-- DEFAULT 0 is conservative for existing rows: if we don't know
-- whether the caller declared, we treat any retry that declares as a
-- potential conflict (safer than silently matching a row that may
-- have been written with different intent).
ALTER TABLE account_reconciliations ADD COLUMN currency_declared INTEGER NOT NULL DEFAULT 0;

-- ── Record this migration ────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (8, '0008_account_reconciliation_currency_declared');
