-- Migration 0004 — Enforce 1:1 predecessor→successor link
-- Forward-only. Never rewrite migrations 0001, 0002, or 0003.
--
-- Each predecessor may have at most one successor (renewal). The application
-- service performs a pre-check via loadSuccessor for fast feedback, but the
-- authoritative race-safe boundary is this UNIQUE index: even if two
-- concurrent INSERTs both reference the same predecessor, one succeeds and
-- the other is rejected by the constraint — leaving zero ambiguous rows and
-- zero partial mutation.

CREATE UNIQUE INDEX IF NOT EXISTS idx_term_deposits_predecessor_unique
  ON term_deposits (predecessor_deposit_id)
  WHERE predecessor_deposit_id IS NOT NULL;

-- ── Record this migration ─────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (4, '0004_term_deposit_predecessor_unique');
