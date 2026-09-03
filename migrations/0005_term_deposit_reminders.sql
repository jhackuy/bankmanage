-- Migration 0005 — Term-deposit reminder records (M1C)
-- Forward-only. Never rewrite migrations 0001–0004.
--
-- This table holds logical reminder records derived from each ACTIVE term
-- deposit's official maturity_date. Per SPEC.md §5, the default offsets are
-- D-30, D-7, D-1 and D0.
--
-- Idempotency boundary:
--   The UNIQUE constraint on (deposit_id, offset_kind) guarantees that repeated
--   scans cannot create duplicate logical reminders. The reminder service uses
--   INSERT OR IGNORE / upsert semantics so a retry after a transient outage
--   creates at most one row per (deposit_id, offset_kind) pair.
--
-- Recovery semantics:
--   A late scan (after target_date) still creates the missing logical reminder
--   row, because the row represents the logical fact "this deposit should
--   have a D-30 reminder", not "this reminder has been delivered on time".
--   Downstream queries filter by status to distinguish pending from delivered.
--
-- Muting semantics:
--   Muting only affects delivery (status -> MUTED). It does NOT change the
--   deposit's lifecycle state. See SPEC.md §5.
--
-- Matured deposits:
--   When a deposit transitions to MATURED_ACTION_REQUIRED, remaining PENDING
--   reminders are cancelled (status -> CANCELLED). The deposit itself remains
--   visible in the action-required query until evidence/ledger closure.

CREATE TABLE IF NOT EXISTS term_deposit_reminders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  deposit_id      INTEGER NOT NULL REFERENCES term_deposits(id) ON DELETE CASCADE,

  -- Which offset relative to the maturity date this reminder represents.
  -- D_MINUS_30 fires 30 days before maturity, D0 fires on maturity date.
  offset_kind     TEXT    NOT NULL
                  CHECK (offset_kind IN ('D_MINUS_30', 'D_MINUS_7', 'D_MINUS_1', 'D0')),

  -- ISO 'YYYY-MM-DD'. The calendar date this reminder is logically due.
  -- Derived deterministically from maturity_date - offset. Stored verbatim
  -- so queries do not need to join term_deposits for the target date.
  target_date     TEXT    NOT NULL,

  -- Reminder lifecycle:
  --   PENDING   -> newly created, not yet delivered, not muted
  --   MUTED     -> delivery paused by user action (does NOT alter deposit)
  --   DELIVERED -> delivery channel reported success (Telegram out of scope)
  --   CANCELLED -> no longer relevant (deposit matured/terminated/cancelled)
  status          TEXT    NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'MUTED', 'DELIVERED', 'CANCELLED')),

  muted_at        TEXT,
  delivered_at    TEXT,
  cancelled_at    TEXT,

  created_at      TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),

  -- The race-safe idempotency boundary: a retry of the same logical
  -- reminder collides here instead of producing a second row.
  UNIQUE (deposit_id, offset_kind)
);

CREATE INDEX IF NOT EXISTS idx_term_deposit_reminders_deposit_id
  ON term_deposit_reminders (deposit_id);
CREATE INDEX IF NOT EXISTS idx_term_deposit_reminders_target_date
  ON term_deposit_reminders (target_date);
CREATE INDEX IF NOT EXISTS idx_term_deposit_reminders_status
  ON term_deposit_reminders (status);

-- ── Record this migration ─────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (5, '0005_term_deposit_reminders');
