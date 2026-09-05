-- Migration 0012 — review_sessions claim-token protocol
-- Forward-only. Never rewrite migrations 0001–0011.
--
-- Adds the `claim_token` column that backs the POSTING/claim-token
-- protocol for the M3C review-and-confirm flows.
--
-- The claim-token protocol is the race-safe boundary that:
--   1. Atomically blocks reject() / correctFields() while a confirmation
--      is mid-flight (the claim slot is held).
--   2. Prevents a failed same-key caller from clearing a claim that
--      another in-flight same-key caller is operating on.
--
-- Why a token and not just the `post_idempotency_key`:
--   Two concurrent same-key callers both hold the same
--   `post_idempotency_key`. The first caller claims the slot and is
--   issued a UUID token; the second caller (same-key retry) sees
--   ALREADY_CLAIMED_SAME_KEY and is NOT issued a new token. Only the
--   caller that holds the token can release the claim. This stops the
--   losing caller from clearing the slot underneath the winner.

ALTER TABLE review_sessions ADD COLUMN claim_token TEXT;

-- ── Record this migration ────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (12, '0012_review_sessions_claim_token');