-- Migration 0015 — Term-deposit reminder atomic delivery claim (M4)
-- Forward-only. Never rewrite migrations 0001–0014.
--
-- Cloudflare Workers run as many independent isolates as the runtime decides.
-- Two overlapping Cron invocations can both observe a PENDING reminder and
-- both call sendMessage() before either writes DELIVERED. That produces
-- duplicate logical delivery of the same financial reminder — a SPEC §5
-- violation ("Recover missed reminders without duplicate logical reminders").
--
-- The UNIQUE (deposit_id, offset_kind) constraint prevents duplicate ROWS
-- but does not prevent duplicate DELIVERY of the same row. The
-- markDelivered UPDATE uses `WHERE status IN ('PENDING', 'MUTED')` which
-- also fails to prevent the race: both invocations can read PENDING and
-- both can transition to DELIVERED before either's UPDATE executes.
--
-- Atomic delivery claim:
--   The new `claimed_at` column is set by an atomic UPDATE before transport.
--   Two concurrent Cron invocations both calling the claim UPDATE: only one
--   observes changes=1 (claimed it), the other observes changes=0 (already
--   claimed) and skips. A transport failure calls releaseClaim (UPDATE
--   clearing claimed_at) so the next tick can retry safely. The markDelivered
--   UPDATE additionally requires `claimed_at IS NOT NULL` so a row can only
--   be finalized from a state we actually claimed.
--
-- This is the second line of defence alongside the existing UNIQUE
-- (deposit_id, offset_kind) idempotency boundary and the telegram_update_id
-- webhook idempotency boundary added in 0014.

ALTER TABLE term_deposit_reminders
  ADD COLUMN claimed_at TEXT;

-- Speeds up the cron scan path that filters `status = 'PENDING' AND
-- claimed_at IS NULL` to avoid re-claiming rows another isolate holds.
CREATE INDEX IF NOT EXISTS idx_term_deposit_reminders_claimed_at
  ON term_deposit_reminders (claimed_at);

-- ── Record this migration ─────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (15, '0015_term_deposit_reminders_claimed_at');