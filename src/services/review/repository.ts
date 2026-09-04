/**
 * Review-session repository interface.
 *
 * Abstract port the application service depends on. The D1 adapter in
 * `d1-repository.ts` provides the production implementation; tests use
 * the same port against the FakeD1Database binding.
 *
 * The repository is responsible for:
 *   - row-to-domain mapping for review_sessions;
 *   - parameterized SQL only;
 *   - JSON serialization of the candidate / corrected / confirmed
 *     payload columns;
 *   - race-safe idempotency on `post_idempotency_key` (UNIQUE column).
 *
 * The repository does NOT:
 *   - apply the OCR review gate (service);
 *   - compose financial transactions (service);
 *   - decide whether a session may be confirmed (service).
 */

import type {
  ConfirmPatch,
  ConfirmResult,
  InsertReviewSessionInput,
  ReviewKind,
  ReviewSessionRecord,
  ReviewStatus,
} from "./types.js";

export interface UpdateCorrectedPayloadResult {
  readonly record: ReviewSessionRecord;
  readonly created: boolean;
}

export interface ConfirmSessionResult {
  readonly session: ReviewSessionRecord;
  readonly created: boolean;
}

export interface ReviewSessionRepository {
  /**
   * Insert a new PENDING_REVIEW session bound to a document.
   * Returns the persisted row.
   */
  insertSession(input: InsertReviewSessionInput): Promise<ReviewSessionRecord>;

  /**
   * Look up a session by id. Returns null if not found.
   */
  findById(id: number): Promise<ReviewSessionRecord | null>;

  /**
   * Update the `corrected_payload_json` and `updated_at` on a
   * PENDING_REVIEW session. The session must be in PENDING_REVIEW for
   * the UPDATE to affect a row (optimistic lock); otherwise throws.
   */
  updateCorrectedPayload(
    id: number,
    patches: Readonly<Record<string, string>>,
    expectedStatus: ReviewStatus
  ): Promise<ReviewSessionRecord>;

  /**
   * Move a PENDING_REVIEW session to CONFIRMED with the supplied
   * confirmed payload + post idempotency key + optional linked
   * transaction. The repository enforces the PENDING_REVIEW lock; if
   * the row's status has moved, this throws and the caller surfaces
   * SESSION_NOT_PENDING.
   *
   * Idempotency: a UNIQUE collision on `post_idempotency_key` is
   * translated into a typed DUPLICATE_IDEMPOTENCY_KEY error by the
   * service. The repository throws on collision and the service
   * maps the error.
   */
  confirmSession(
    id: number,
    patch: ConfirmPatch,
    expectedStatus: ReviewStatus,
    expectedKind: ReviewKind
  ): Promise<ConfirmSessionResult>;

  /**
   * Move a PENDING_REVIEW session to REJECTED with an optional reason.
   * Same optimistic-lock semantics as `confirmSession`.
   */
  rejectSession(
    id: number,
    reason: string | null,
    expectedStatus: ReviewStatus
  ): Promise<ConfirmSessionResult>;
}

export type { ConfirmResult };
