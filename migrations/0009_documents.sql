-- Migration 0009 — M3A: document/evidence metadata
-- Forward-only. Never rewrite migrations 0001–0008.
--
-- This migration adds the metadata table for the M3A document/evidence slice.
-- R2 holds the actual binary payload; this table records the immutable
-- metadata that ties the private object back to a household member.
--
-- SPEC §11 contract enforced here:
--   - "R2 objects are private." The application never persists an
--     unrestricted public bucket URL — only the opaque R2 object_key.
--   - "Financial documents are never served through an unrestricted
--     public bucket URL."
--   - "OCR/vision output never directly posts a financial transaction
--     or finalizes a deposit." M3A stores the bytes only; receipt
--     candidate extraction is out of scope.
--
-- SPEC §4.3 contract enforced here:
--   - "Posted records are not hard-deleted." The documents table has
--     no DELETE path; M3A exposes only insert + immutable read.
--
-- Idempotency boundary:
--   - sha256_hex is NOT database-unique — the service performs a
--     pre-INSERT lookup against the sha256 index and returns the
--     existing row if one is found. Two different M3A logical
--     documents with the same bytes are forbidden, but the rejection
--     happens at the service boundary (SPEC §6.2: "Detect exact
--     duplicate images by hash").
--
-- Privacy boundary:
--   - The original filename is NOT stored. The application derives a
--     safe object_key; the user-supplied filename never reaches
--     storage or this table.
--
-- Lifecycle:
--   - lifecycle_state is locked to 'ACTIVE' in M3A. Terminal semantics
--     are intentional — documents are append-only and there is no
--     physical delete.

CREATE TABLE IF NOT EXISTS documents (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  kind               TEXT    NOT NULL CHECK (kind IN (
                       'RECEIPT',
                       'TERM_DEPOSIT_CERTIFICATE',
                       'RENEWAL_ADVICE',
                       'SETTLEMENT_EVIDENCE'
                     )),
  owner_member_id    INTEGER NOT NULL REFERENCES household_members(id),
  uploader_member_id INTEGER NOT NULL REFERENCES household_members(id),
  content_type       TEXT    NOT NULL,
  byte_size          INTEGER NOT NULL CHECK (byte_size > 0),
  sha256_hex         TEXT    NOT NULL CHECK (length(sha256_hex) = 64),
  object_key         TEXT    NOT NULL UNIQUE,
  lifecycle_state    TEXT    NOT NULL DEFAULT 'ACTIVE'
                                  CHECK (lifecycle_state IN ('ACTIVE')),
  created_at         TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_documents_sha256_hex
  ON documents (sha256_hex);
CREATE INDEX IF NOT EXISTS idx_documents_owner_member_id
  ON documents (owner_member_id);
CREATE INDEX IF NOT EXISTS idx_documents_uploader_member_id
  ON documents (uploader_member_id);
CREATE INDEX IF NOT EXISTS idx_documents_kind
  ON documents (kind);

-- ── Record this migration ────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (9, '0009_documents');