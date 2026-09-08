-- Migration 0013 — Term-deposit creation idempotency boundary (M3C)
-- Forward-only. Never rewrite migrations 0001 through 0012.
--
-- The M3C review confirm path creates a DRAFT term_deposits row inside the
-- claim-window. If the post-create step (confirmSession binding the deposit
-- id to the review session) fails after the row has been inserted, the same
-- idempotency key caller must retry to the SAME row — without this column
-- a retry would create a duplicate deposit and the session's depositId is
-- still NULL. The UNIQUE index is the authoritative race-safe boundary:
-- even if two concurrent same-key callers slip past the claim, only one
-- INSERT succeeds.
--
-- Mirrors the pattern used by transactions.idempotency_key (RECEIPT
-- flow) and review_sessions.post_idempotency_key (claim protocol).

ALTER TABLE term_deposits ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_term_deposits_idempotency_key_unique
  ON term_deposits (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── Record this migration ─────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (13, '0013_term_deposits_idempotency_key');
