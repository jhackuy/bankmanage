-- Migration 0002 — Enforce one Telegram identity per household member
-- Keep the identity relationship truly 1:1 without rewriting migration 0001.

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_identities_member_id_unique
  ON telegram_identities (member_id);

INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (2, '0002_telegram_identity_member_unique');
