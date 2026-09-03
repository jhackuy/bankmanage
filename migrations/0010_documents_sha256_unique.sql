-- Migration 0010 — Enforce race-safe exact duplicate detection on documents
-- Forward-only. Never rewrite migrations 0001–0009.
--
-- Migration 0009 created `documents` with a non-unique index on
-- `sha256_hex`. The service pre-check (a SELECT against that index)
-- catches most duplicates, but two concurrent uploads with identical
-- bytes can both pass the pre-check and both reach the INSERT. The
-- authoritative race-safe boundary for exact duplicate detection is a
-- UNIQUE index on the byte-content hash.
--
-- SPEC §6.2 contract enforced here:
--   "Detect exact duplicate images by hash" — two different M3A
--   logical documents with the same bytes are forbidden. The
--   rejection must hold even under concurrent uploads, so the
--   database itself must reject a second insert.
--
-- SPEC §4.3 contract: documents are append-only; no DELETE. The
-- unique index is the strongest available guarantee and does not
-- require any application-level cleanup.
--
-- The object_key UNIQUE column added in 0009 is the secondary
-- boundary; sha256_hex is the primary duplicate-content boundary.

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_sha256_hex_unique
  ON documents (sha256_hex);

-- ── Record this migration ────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (10, '0010_documents_sha256_unique');
