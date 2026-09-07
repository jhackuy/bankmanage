-- Migration 0014 — Telegram webhook update_id idempotency (M4)
-- Forward-only. Never rewrite migrations 0001–0013.
--
-- Cloudflare Workers run as many independent isolates as the runtime decides.
-- An in-process update deduper (Map keyed by update_id) cannot survive across
-- isolates, so a replayed webhook would be re-handled on a different isolate.
-- The UNIQUE constraint on update_id is the race-safe boundary: two concurrent
-- isolates that both attempt to INSERT the same update_id will see exactly one
-- row created, and the other can short-circuit as a duplicate replay.
--
-- Idempotency boundary:
--   The D1UpdateDeduper uses INSERT OR IGNORE: the first writer succeeds,
--   subsequent writers observe changes=0 and report the update_id as already
--   claimed. This is the second line of defence alongside the existing
--   UNIQUE (deposit_id, offset_kind) constraint on term_deposit_reminders.
--
-- Retention:
--   Rows older than 7 days are safe to prune; Telegram guarantees update_ids
--   are strictly monotonically increasing, so a replayed id is always
--   _strictly older_ than the newest live id. Tests use a short retention
--   window; production cleanup is the responsibility of the cron worker.

CREATE TABLE IF NOT EXISTS telegram_update_idempotency (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id    INTEGER NOT NULL UNIQUE,
  claimed_at   TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_telegram_update_idempotency_claimed_at
  ON telegram_update_idempotency (claimed_at);

-- ── Record this migration ─────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (14, '0014_telegram_update_idempotency');
