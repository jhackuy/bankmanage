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

/**
 * Discriminated union returned by `claimSession`. Describes the outcome
 * of attempting to reserve the session's `post_idempotency_key` slot
 * BEFORE the financial write. The service uses this to:
 *   - admit a new caller to the post step (CLAIMED);
 *   - admit a same-key retry to the post step (ALREADY_CLAIMED_SAME_KEY);
 *   - reject a different-key caller before any financial write
 *     (ALREADY_CLAIMED_DIFFERENT_KEY);
 *   - surface stale-state and kind-mismatch errors before any write
 *     (NOT_PENDING / KIND_MISMATCH / NOT_FOUND).
 *
 * The persisted token marks the held claim, but the service never clears
 * the claim after a post failure. Only a retry with the same key is
 * admitted, while every other key remains blocked.
 */
export type ClaimSessionResult =
  | { readonly code: "CLAIMED" }
  | { readonly code: "ALREADY_CLAIMED_SAME_KEY" }
  | { readonly code: "ALREADY_CLAIMED_DIFFERENT_KEY" }
  | { readonly code: "NOT_PENDING" }
  | { readonly code: "KIND_MISMATCH" }
  | { readonly code: "NOT_FOUND" };

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
   * Reserve the session's `post_idempotency_key` slot for a caller.
   *
   * The reservation runs as an atomic UPDATE with an optimistic lock on
   * `status = 'PENDING_REVIEW'` AND the supplied `expectedKind`. It
   * succeeds (CLAIMED) only when the session is still PENDING_REVIEW,
   * matches the kind, and the slot is either NULL or already holds the
   * same key.
   *
   * The ALREADY_CLAIMED_SAME_KEY branch is the same-key retry path: a
   * previous attempt claimed the slot but failed mid-write (post or
   * confirm step), so the caller is admitted again to resume the flow.
   * The transactions / term-deposits UNIQUE on the idempotency key keeps
   * the retry a no-op at the financial layer.
   *
   * The ALREADY_CLAIMED_DIFFERENT_KEY branch prevents two concurrent
   * confirmations with different idempotency keys from both producing
   * downstream writes. The service surfaces this as SESSION_CLAIM_CONFLICT.
   *
   * `expectedKind` is the kind the caller intends to confirm — e.g.
   * "RECEIPT" for `confirmReceipt`, "DEPOSIT" for `confirmDeposit`.
   * Sessions of other kinds surface KIND_MISMATCH so a caller cannot
   * reuse a RECEIPT idempotency key to finalize a DEPOSIT session (or
   * vice versa).
   */
  claimSession(id: number, postIdempotencyKey: string, expectedKind: ReviewKind): Promise<ClaimSessionResult>;

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
