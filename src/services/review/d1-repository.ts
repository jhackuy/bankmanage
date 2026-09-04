/**
 * D1 implementation of the review-session repository.
 *
 * All SQL is parameterized; no JSON operations happen in JavaScript.
 * JSON serialization/deserialization is performed in pure helpers
 * (`rowToSession`, session-shaped bind values) so the row→domain
 * mapping is testable and deterministic.
 *
 * The optimistic-lock pattern (`UPDATE ... WHERE status = ?`) is the
 * same pattern the term-deposit repository uses (SPEC §4.2 race-safe
 * state transitions). A 0-row update means the session moved out of
 * PENDING_REVIEW between our SELECT and UPDATE — the service surfaces
 * that as SESSION_NOT_PENDING.
 *
 * `post_idempotency_key` UNIQUE is the second race-safe boundary: two
 * concurrent callers confirming the same session CANNOT produce two
 * financial posts because only one INSERT can hold the key.
 */

import type { D1Database } from "../../adapters/d1/types.js";
import type { OcrReviewDecision } from "../../adapters/ocr/confidence.js";
import type { OcrExtractionResult } from "../../adapters/ocr/interface.js";
import type {
  ConfirmPatch,
  InsertReviewSessionInput,
  ReviewSessionRecord,
  ReviewStatus,
  ReviewKind,
} from "./types.js";
import type { ConfirmSessionResult, ReviewSessionRepository } from "./repository.js";

// ── Row type as stored in SQLite ─────────────────────────────────────────────

interface ReviewSessionRow {
  id: number;
  kind: string;
  status: string;
  document_id: number;
  deposit_id: number | null;
  confirming_member_id: number;
  review_decision_json: string;
  candidate_payload_json: string;
  corrected_payload_json: string;
  confirmed_payload_json: string | null;
  post_idempotency_key: string | null;
  linked_transaction_id: number | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function jsonParse<T>(s: string | null): T {
  if (s === null) {
    throw new Error("expected non-null JSON column");
  }
  return JSON.parse(s) as T;
}

function rowToSession(row: ReviewSessionRow): ReviewSessionRecord {
  return {
    id: row.id,
    kind: row.kind as ReviewSessionRecord["kind"],
    status: row.status as ReviewSessionRecord["status"],
    documentId: row.document_id,
    depositId: row.deposit_id,
    confirmingMemberId: row.confirming_member_id,
    reviewDecision: jsonParse<OcrReviewDecision>(row.review_decision_json),
    candidatePayload: jsonParse<OcrExtractionResult>(row.candidate_payload_json),
    correctedPayload: jsonParse<Record<string, string>>(row.corrected_payload_json),
    confirmedPayload:
      row.confirmed_payload_json === null
        ? null
        : jsonParse<Record<string, unknown>>(row.confirmed_payload_json),
    postIdempotencyKey: row.post_idempotency_key,
    linkedTransactionId: row.linked_transaction_id,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── D1 Repository ────────────────────────────────────────────────────────────

export class D1ReviewSessionRepository implements ReviewSessionRepository {
  constructor(private readonly db: D1Database) {}

  async insertSession(input: InsertReviewSessionInput): Promise<ReviewSessionRecord> {
    const stmt = this.db
      .prepare(
        `INSERT INTO review_sessions (
           kind, status, document_id, deposit_id, confirming_member_id,
           review_decision_json, candidate_payload_json, corrected_payload_json,
           reason
         ) VALUES (
           ?, 'PENDING_REVIEW', ?, ?, ?,
           ?, ?, ?,
           ?
         )
         RETURNING *`
      )
      .bind(
        input.kind,
        input.documentId,
        input.depositId,
        input.confirmingMemberId,
        JSON.stringify(input.reviewDecision),
        JSON.stringify(input.candidatePayload),
        JSON.stringify(input.correctedPayload),
        input.reason
      );
    const row = await stmt.first<ReviewSessionRow>();
    if (row === null) {
      throw new Error("review session insert returned no row");
    }
    return rowToSession(row);
  }

  async findById(id: number): Promise<ReviewSessionRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM review_sessions WHERE id = ?")
      .bind(id)
      .first<ReviewSessionRow>();
    return row === null ? null : rowToSession(row);
  }

  async updateCorrectedPayload(
    id: number,
    patches: Readonly<Record<string, string>>,
    expectedStatus: ReviewStatus
  ): Promise<ReviewSessionRecord> {
    // Read-modify-write on the JSON column. The optimistic WHERE-status
    // lock guards against a concurrent confirm/reject racing us.
    const existing = await this.findById(id);
    if (existing === null) {
      throw new Error("session not found");
    }
    if (existing.status !== expectedStatus) {
      throw new Error(`stale state during corrected-payload update: ${existing.status}`);
    }
    const merged: Record<string, string> = { ...existing.correctedPayload, ...patches };
    const stmt = this.db
      .prepare(
        `UPDATE review_sessions
           SET corrected_payload_json = ?, updated_at = datetime('now', 'utc')
         WHERE id = ? AND status = ?
         RETURNING *`
      )
      .bind(JSON.stringify(merged), id, expectedStatus);
    const row = await stmt.first<ReviewSessionRow>();
    if (row === null) {
      throw new Error("stale state during corrected-payload update");
    }
    return rowToSession(row);
  }

  async confirmSession(
    id: number,
    patch: ConfirmPatch,
    expectedStatus: ReviewStatus,
    expectedKind: ReviewKind
  ): Promise<ConfirmSessionResult> {
    // First, attempt the optimistic UPDATE.
    const update = this.db
      .prepare(
        `UPDATE review_sessions
           SET status = 'CONFIRMED',
               confirmed_payload_json = ?,
               post_idempotency_key = ?,
               linked_transaction_id = ?,
               updated_at = datetime('now', 'utc')
         WHERE id = ? AND status = ? AND kind = ?
         RETURNING *`
      )
      .bind(
        JSON.stringify(patch.confirmedPayload),
        patch.postIdempotencyKey,
        patch.linkedTransactionId,
        id,
        expectedStatus,
        expectedKind
      );

    let row: ReviewSessionRow | null;
    try {
      row = await update.first<ReviewSessionRow>();
    } catch (err) {
      // UNIQUE on post_idempotency_key race-safety. Surface the typed
      // collision so the service can map it.
      if (
        err instanceof Error &&
        /UNIQUE constraint failed: review_sessions\.post_idempotency_key/i.test(err.message)
      ) {
        throw new Error("DUPLICATE_IDEMPOTENCY_KEY");
      }
      throw err;
    }

    if (row === null) {
      // Stale-state lock lost. Confirm whether it was a status move or
      // a kind mismatch so the service can pick the right error code.
      const existing = await this.findById(id);
      if (existing === null) throw new Error("SESSION_NOT_FOUND");
      if (existing.status !== expectedStatus) throw new Error("SESSION_NOT_PENDING");
      if (existing.kind !== expectedKind) throw new Error("SESSION_KIND_MISMATCH");
      throw new Error("STALE_STATE");
    }
    return { session: rowToSession(row), created: true };
  }

  async rejectSession(
    id: number,
    reason: string | null,
    expectedStatus: ReviewStatus
  ): Promise<ConfirmSessionResult> {
    const stmt = this.db
      .prepare(
        `UPDATE review_sessions
           SET status = 'REJECTED',
               reason = ?,
               updated_at = datetime('now', 'utc')
         WHERE id = ? AND status = ?
         RETURNING *`
      )
      .bind(reason, id, expectedStatus);
    const row = await stmt.first<ReviewSessionRow>();
    if (row === null) {
      const existing = await this.findById(id);
      if (existing === null) throw new Error("SESSION_NOT_FOUND");
      if (existing.status !== expectedStatus) throw new Error("SESSION_NOT_PENDING");
      throw new Error("STALE_STATE");
    }
    return { session: rowToSession(row), created: true };
  }
}
