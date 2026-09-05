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
import type { ClaimSessionResult, ConfirmSessionResult, ReviewSessionRepository } from "./repository.js";

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
  claim_token: string | null;
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
    claimToken: row.claim_token,
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
    // lock guards against a concurrent confirm/reject racing us. The
    // `post_idempotency_key IS NULL` guard blocks correct() while a
    // confirmation is mid-flight — claim-protected.
    const existing = await this.findById(id);
    if (existing === null) {
      throw new Error("session not found");
    }
    if (existing.status !== expectedStatus) {
      throw new Error(`stale state during corrected-payload update: ${existing.status}`);
    }
    if (existing.postIdempotencyKey !== null) {
      throw new Error("session is mid-confirmation; cannot correct fields");
    }
    const merged: Record<string, string> = { ...existing.correctedPayload, ...patches };
    const stmt = this.db
      .prepare(
        `UPDATE review_sessions
           SET corrected_payload_json = ?, updated_at = datetime('now', 'utc')
         WHERE id = ? AND status = ? AND post_idempotency_key IS NULL
         RETURNING *`
      )
      .bind(JSON.stringify(merged), id, expectedStatus);
    const row = await stmt.first<ReviewSessionRow>();
    if (row === null) {
      throw new Error("stale state during corrected-payload update");
    }
    return rowToSession(row);
  }

  async claimSession(id: number, postIdempotencyKey: string): Promise<ClaimSessionResult> {
    // Step 1: read the current state so we can distinguish a fresh
    // claim from a same-key retry without trusting a returned row.
    const existing = await this.findById(id);
    if (existing === null) return { code: "NOT_FOUND" };
    if (existing.status !== "PENDING_REVIEW") return { code: "NOT_PENDING" };
    if (existing.kind !== "RECEIPT") return { code: "KIND_MISMATCH" };

    // Same-key retry: slot already holds our key from a prior
    // mid-write crash. The post step's idempotency_key UNIQUE keeps
    // the retry a no-op at the financial layer. The retry is admitted
    // to the post step, but it does NOT own the claim token — only
    // the original claimer can call releaseClaim.
    if (existing.postIdempotencyKey === postIdempotencyKey) {
      if (existing.claimToken === null) {
        throw new Error("claim slot held without token");
      }
      return { code: "ALREADY_CLAIMED_SAME_KEY", claimToken: existing.claimToken };
    }
    // Different-key conflict: another caller is mid-flight with a
    // distinct idempotency key. Reject before any financial write.
    if (existing.postIdempotencyKey !== null) {
      return { code: "ALREADY_CLAIMED_DIFFERENT_KEY" };
    }

    // Step 2: slot is NULL — attempt the atomic claim with optimistic
    // lock on (status, kind, slot IS NULL). Generate a UUID token
    // that authorizes the matching releaseClaim. A concurrent caller
    // could have claimed the slot between our SELECT and UPDATE; the
    // WHERE clause guards against that race and the UPDATE returns
    // the persisted token on success.
    const claimToken = crypto.randomUUID();
    const row = await this.db
      .prepare(
        `UPDATE review_sessions
           SET post_idempotency_key = ?,
               claim_token = ?,
               updated_at = datetime('now', 'utc')
         WHERE id = ?
           AND status = 'PENDING_REVIEW'
           AND kind = 'RECEIPT'
           AND post_idempotency_key IS NULL
         RETURNING claim_token`
      )
      .bind(postIdempotencyKey, claimToken, id)
      .first<{ claim_token: string }>();
    if (row !== null && row.claim_token !== null) {
      return { code: "CLAIMED", claimToken: row.claim_token };
    }

    // Lost the race to a concurrent claim. Re-check to map to a
    // precise outcome.
    const recheck = await this.findById(id);
    if (recheck === null) return { code: "NOT_FOUND" };
    if (recheck.status !== "PENDING_REVIEW") return { code: "NOT_PENDING" };
    if (recheck.kind !== "RECEIPT") return { code: "KIND_MISMATCH" };
    if (recheck.postIdempotencyKey === postIdempotencyKey) {
      if (recheck.claimToken === null) {
        throw new Error("claim slot held without token");
      }
      return { code: "ALREADY_CLAIMED_SAME_KEY", claimToken: recheck.claimToken };
    }
    return { code: "ALREADY_CLAIMED_DIFFERENT_KEY" };
  }

  async releaseClaim(id: number, postIdempotencyKey: string, claimToken: string): Promise<void> {
    // Token-protocol boundary: only release when the session is still
    // PENDING_REVIEW AND the slot currently holds the key we are
    // trying to clear AND the stored claim_token matches the token we
    // were issued. This prevents:
    //   - a concurrent confirm/reject from clobbering a terminal state;
    //   - a different-key caller from clearing a slot it doesn't own;
    //   - a failed same-key caller from clearing the slot underneath
    //     another in-flight same-key caller (only the original
    //     claimer holds the token).
    await this.db
      .prepare(
        `UPDATE review_sessions
           SET post_idempotency_key = NULL,
               claim_token = NULL,
               updated_at = datetime('now', 'utc')
         WHERE id = ?
           AND status = 'PENDING_REVIEW'
           AND post_idempotency_key = ?
           AND claim_token = ?`
      )
      .bind(id, postIdempotencyKey, claimToken)
      .run();
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
               claim_token = NULL,
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
      // Stale-state lock lost. Distinguish the exact reason so the
      // service can pick the right error code, AND honor the same-key
      // retry resume: if the session is already CONFIRMED with the
      // caller's idempotency key, the retry is a no-op success (the
      // transactions UNIQUE already kept the financial write to one
      // row — the claim slot pre-empts the race, but we keep this as a
      // safety net for direct repository misuse).
      const existing = await this.findById(id);
      if (existing === null) throw new Error("SESSION_NOT_FOUND");
      if (existing.status === "CONFIRMED" && existing.postIdempotencyKey === patch.postIdempotencyKey) {
        return { session: existing, created: false };
      }
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
    // The `post_idempotency_key IS NULL` guard blocks reject() while
    // a confirmation is mid-flight — claim-protected.
    const stmt = this.db
      .prepare(
        `UPDATE review_sessions
           SET status = 'REJECTED',
               reason = ?,
               updated_at = datetime('now', 'utc')
         WHERE id = ? AND status = ? AND post_idempotency_key IS NULL
         RETURNING *`
      )
      .bind(reason, id, expectedStatus);
    const row = await stmt.first<ReviewSessionRow>();
    if (row === null) {
      const existing = await this.findById(id);
      if (existing === null) throw new Error("SESSION_NOT_FOUND");
      if (existing.status !== expectedStatus) throw new Error("SESSION_NOT_PENDING");
      if (existing.postIdempotencyKey !== null) throw new Error("SESSION_CLAIMED");
      throw new Error("STALE_STATE");
    }
    return { session: rowToSession(row), created: true };
  }
}
