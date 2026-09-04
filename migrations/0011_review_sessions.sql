-- Migration 0011 — M3C: review sessions for receipt/deposit/settlement flows
-- Forward-only. Never rewrite migrations 0001–0010.
--
-- This migration adds the `review_sessions` table that backs the M3C
-- bounded review-and-confirm flows for receipt, term-deposit-draft, and
-- settlement candidates.
--
-- SPEC §6.2 contract enforced here:
--   "OCR output is always a candidate, never a financial source of
--    truth." The review_sessions table stores user-confirmed facts in
--    `confirmed_payload_json` and is the only authorized input for the
--    downstream financial writes that confirmReceipt/confirmDeposit/
--    confirmSettlement issue.
--
-- SPEC §4.3 contract:
--   "Posted records are not hard-deleted." Review sessions move through
--   PENDING_REVIEW → {CONFIRMED | REJECTED} but the row is never
--   physically removed; REJECTED is the terminal draft-cancel outcome.
--
-- Speculative OCR fields are stored as JSON in `candidate_payload_json`
-- (verbatim from OcrExtractionResult). The application service never
-- trusts those columns for the financial write; the only authoritative
-- field set for the post is `confirmed_payload_json` which is populated
-- only on confirmReceipt / confirmDeposit / confirmSettlement after the
-- user explicitly approves it.
--
-- Terminal-state semantics:
--   - status='CONFIRMED' ⇒ confirmed_payload_json is non-null and the
--     confirm_* method has produced exactly one of: transactions row
--     and/or term_deposits row + document linkage columns.
--   - status='REJECTED' ⇒ confirmed_payload_json is null. Zero financial
--     mutation has occurred regardless of how many candidate corrections
--     were applied.
--
-- Each review session is bound to EXACTLY ONE document via document_id.
-- The document is uploaded via the M3A flow first; the review session
-- inherits the opaque object_key implicitly via the document row.
--
-- Idempotency for the financial write:
--   - `post_idempotency_key` UNIQUE column. The confirm_* methods pass a
--     caller-supplied idempotency key; UNIQUE prevents two confirmations
--     of the same session from posting two transactions.

CREATE TABLE IF NOT EXISTS review_sessions (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                      TEXT    NOT NULL CHECK (kind IN (
                              'RECEIPT',
                              'DEPOSIT',
                              'SETTLEMENT'
                            )),
  status                    TEXT    NOT NULL DEFAULT 'PENDING_REVIEW'
                                      CHECK (status IN (
                                        'PENDING_REVIEW',
                                        'CONFIRMED',
                                        'REJECTED'
                                      )),
  document_id               INTEGER NOT NULL REFERENCES documents(id),
  deposit_id                INTEGER REFERENCES term_deposits(id),
  confirming_member_id      INTEGER NOT NULL REFERENCES household_members(id),
  review_decision_json      TEXT    NOT NULL,
  candidate_payload_json    TEXT    NOT NULL,
  corrected_payload_json    TEXT    NOT NULL DEFAULT '{}',
  confirmed_payload_json    TEXT,
  post_idempotency_key      TEXT    UNIQUE,
  linked_transaction_id     INTEGER REFERENCES transactions(id),
  reason                    TEXT,
  created_at                TEXT    NOT NULL DEFAULT (datetime('now', 'utc')),
  updated_at                TEXT    NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE INDEX IF NOT EXISTS idx_review_sessions_document_id
  ON review_sessions (document_id);
CREATE INDEX IF NOT EXISTS idx_review_sessions_deposit_id
  ON review_sessions (deposit_id);
CREATE INDEX IF NOT EXISTS idx_review_sessions_confirming_member_id
  ON review_sessions (confirming_member_id);
CREATE INDEX IF NOT EXISTS idx_review_sessions_status
  ON review_sessions (status);

-- ── Record this migration ────────────────────────────────────────────────────
INSERT OR IGNORE INTO migration_metadata (version, name) VALUES
  (11, '0011_review_sessions');
