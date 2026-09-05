-- Migration 0016 — Term-deposit reminder claim ownership token (M4)
-- Forward-only. Never rewrite migrations 0001–0015.
--
-- Migration 0015 added `claimed_at` for the atomic delivery claim boundary.
-- That prevents two concurrent Cron invocations from BOTH sending the same
-- reminder, but the claim lifecycle has two gaps:
--
--   1. No stale-claim recovery. If a Worker crashes or is terminated after
--      claimForDelivery but before markDelivered/releaseClaim, the row stays
--      PENDING + claimed_at forever. Every later Cron sees changes=0 from
--      the WHERE clause (`claimed_at IS NULL`) and the reminder is never
--      delivered again. SPEC §5 requires recovering missed reminders after
--      temporary outages.
--
--   2. No ownership token. Even with a lease timeout, timestamp-only
--      matching is an ABA race: the original slow Worker can later call
--      markDelivered or releaseClaim on a NEWER Worker's claim for the
--      same row, silently clearing or finalizing the wrong delivery.
--
-- This migration adds `claim_token`, a randomly generated opaque string
-- stored atomically with the claim. claimForDelivery returns the token to
-- the caller; markDelivered and releaseClaim require the same token to
-- take effect, so an old claimant cannot finalize or clear a replacement
-- claim. The token is cleared together with `claimed_at` on release or
-- finalize.

ALTER TABLE term_deposit_reminders
  ADD COLUMN claim_token TEXT;

-- ── Record this migration ─────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (16, '0016_term_deposit_reminders_claim_token');