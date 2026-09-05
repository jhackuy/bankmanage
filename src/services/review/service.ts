/**
 * M3C bounded review application service.
 *
 * Platform-neutral orchestration for the M3C review-and-confirm flows.
 * This slice implements PHASE 1 (RECEIPT) only. DEPOSIT and SETTLEMENT
 * are intentionally NOT implemented in this slice; their entrypoints
 * remain part of the type system but the service methods are deferred.
 *
 * SPEC.md contracts enforced here:
 *   §6.2 — OCR output is always a candidate, never a financial source of
 *          truth. The review gate is applied at submit time AND re-
 *          evaluated at confirm time against the FINAL user-confirmed
 *          amount and date — corrections cannot bypass the gate.
 *   §4.2 — Race-safe state transitions via optimistic-lock pattern in
 *          the repository (`UPDATE ... WHERE status = ?`). Stale state
 *          surfaces as SESSION_NOT_PENDING.
 *   §4.3 — Posted records are not hard-deleted. REJECTED is the terminal
 *          draft-cancel outcome; rejected sessions produce zero
 *          financial mutation regardless of how many candidate
 *          corrections were applied.
 *   §7   — Financial writes are idempotent on `idempotency_key` UNIQUE
 *          (transactions) and `post_idempotency_key` UNIQUE
 *          (review_sessions).
 *
 * Failure atomicity (confirmReceipt):
 *   1. Load and authorize the session and the document.
 *   2. Re-evaluate the OCR review gate against the FINAL user-confirmed
 *      amount and date. If the gate would fail on the user-confirmed
 *      facts, surface REVIEW_GATE_FAILED BEFORE any financial write.
 *   3. Validate account ownership / active / currency.
 *   4. Validate category active.
 *   5. CLAIM the session's post_idempotency_key slot. The claim runs as
 *      an atomic UPDATE keyed on (status='PENDING_REVIEW',
 *      post_idempotency_key IS NULL OR = ?). Two concurrent callers
 *      with different keys cannot both win — the second caller sees
 *      ALREADY_CLAIMED_DIFFERENT_KEY and is rejected with
 *      SESSION_CLAIM_CONFLICT BEFORE any transaction is posted. A
 *      same-key retry sees ALREADY_CLAIMED_SAME_KEY and proceeds (the
 *      transactions UNIQUE keeps the retry a no-op at the financial
 *      layer).
 *   6. Post the transaction via TransactionApplicationService with
 *      `sourceEvidenceRef = "doc:" + documentId` and the caller-supplied
 *      idempotencyKey. The claim is intentionally RETAINED on every
 *      post failure — only a same-key retry is admitted to recover,
 *      every other key remains blocked. This prevents an original
 *      caller from clearing the slot underneath an in-flight same-key
 *      retry after the original caller's post fails.
 *   7. Confirm the session via the repository with
 *      `postIdempotencyKey` and `linkedTransactionId`. Confirmation
 *      clears the claim token as part of moving to CONFIRMED.
 *   8. If confirmSession throws DUPLICATE_IDEMPOTENCY_KEY (defense in
 *      depth — should not happen now that the claim pre-empts the race),
 *      look up the already-linked transaction and return it as success
 *      (idempotent retry).
 *
 * The claim-then-post ordering is the race-safe boundary: posting first
 * would let two concurrent callers with different keys both write a
 * transaction before only one wins the optimistic lock on
 * confirmSession. The claim ensures at most one financial write per
 * idempotency key per session.
 */

import { decideOcrReview } from "../../adapters/ocr/confidence.js";
import type { AccountRepository } from "../accounts/repository.js";
import type { CategoryRepository } from "../categories/repository.js";
import { DocumentApplicationService } from "../documents-storage/service.js";
import type { TransactionApplicationService } from "../transactions/service.js";
import type { ServiceErrorCode as TxServiceErrorCode } from "../transactions/types.js";
import { fail, ok, type ServiceErrorCode, type ServiceResult } from "./types.js";
import type { ReviewSessionRepository } from "./repository.js";
import type {
  ConfirmReceiptInput,
  ConfirmResult,
  CorrectFieldsInput,
  RejectInput,
  ReviewSessionRecord,
  ReviewSessionView,
  SubmitForReviewInput,
} from "./types.js";

// ── Service ──────────────────────────────────────────────────────────────────

export class ReviewApplicationService {
  constructor(
    private readonly reviewRepo: ReviewSessionRepository,
    private readonly docService: DocumentApplicationService,
    private readonly txService: TransactionApplicationService,
    private readonly accountRepo: AccountRepository,
    private readonly categoryRepo: CategoryRepository
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Fetch a review session, authorizing the requesting member against
   * the underlying document (owner, uploader, or persisted OWNER role).
   */
  async getSession(sessionId: number, memberId: number): Promise<ServiceResult<ReviewSessionView>> {
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      return fail("INVALID_INPUT", "sessionId must be a positive safe integer");
    }
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }

    const session = await this.reviewRepo.findById(sessionId);
    if (session === null) {
      return fail("SESSION_NOT_FOUND", `review session ${sessionId} not found`);
    }
    const docAccess = await this.docService.getDocument(session.documentId, memberId);
    if (!docAccess.ok) {
      // Propagate DOCUMENT_NOT_FOUND / DOCUMENT_FORBIDDEN / MEMBER_*
      // directly so the caller can distinguish access denial from missing
      // data.
      return docAccess;
    }
    return ok({ session, gateAcceptable: !session.reviewDecision.requiresReview });
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  /**
   * Submit a new PENDING_REVIEW session. The OCR review gate is applied
   * using the supplied OcrExtractionResult and the resulting decision is
   * persisted on the session. The gate is advisory at submit time; it is
   * re-evaluated at confirm time against the FINAL user-confirmed facts.
   *
   * Document authorization: the caller must already be able to access the
   * underlying document via `DocumentApplicationService.getDocument`. The
   * confirming member recorded on the session is the member who submitted
   * the candidate.
   */
  async submitForReview(input: SubmitForReviewInput): Promise<ServiceResult<ReviewSessionView>> {
    if (!Number.isSafeInteger(input.documentId) || input.documentId <= 0) {
      return fail("INVALID_INPUT", "documentId must be a positive safe integer");
    }
    if (!Number.isSafeInteger(input.confirmingMemberId) || input.confirmingMemberId <= 0) {
      return fail("INVALID_INPUT", "confirmingMemberId must be a positive safe integer");
    }

    const decision = decideOcrReview(input.ocrResult);
    const docAccess = await this.docService.getDocument(input.documentId, input.confirmingMemberId);
    if (!docAccess.ok) {
      return docAccess;
    }
    const record = input.documentId > 0 && docAccess.value === null ? null : docAccess.value;
    // getDocument returns ServiceResult<DocumentRecord | null>; we treat
    // a null record (no row) as DOCUMENT_NOT_FOUND so we surface a typed
    // error instead of trying to insert a session bound to a missing
    // document row (the FK would reject it anyway).
    if (record === null) {
      return fail("DOCUMENT_NOT_FOUND", `document ${input.documentId} not found`);
    }

    const session = await this.reviewRepo.insertSession({
      kind: "RECEIPT",
      documentId: input.documentId,
      depositId: input.depositId ?? null,
      confirmingMemberId: input.confirmingMemberId,
      reviewDecision: decision,
      candidatePayload: input.ocrResult,
      correctedPayload: {},
      reason: input.reason ?? null,
    });
    return ok({ session, gateAcceptable: !decision.requiresReview });
  }

  // ── Correct ────────────────────────────────────────────────────────────────

  /**
   * Patch the advisory `correctedPayload` of a PENDING_REVIEW session.
   * Only fields present in `patches` are updated; absent fields keep
   * their current value. The corrected payload is advisory — it is NOT
   * used for the financial write. The confirm input is.
   */
  async correctFields(input: CorrectFieldsInput): Promise<ServiceResult<ReviewSessionRecord>> {
    if (!Number.isSafeInteger(input.sessionId) || input.sessionId <= 0) {
      return fail("INVALID_INPUT", "sessionId must be a positive safe integer");
    }
    if (!Number.isSafeInteger(input.memberId) || input.memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }

    const existing = await this.reviewRepo.findById(input.sessionId);
    if (existing === null) {
      return fail("SESSION_NOT_FOUND", `review session ${input.sessionId} not found`);
    }
    if (existing.status !== "PENDING_REVIEW") {
      return fail("SESSION_NOT_PENDING", `session ${input.sessionId} is ${existing.status}`);
    }
    if (existing.kind !== "RECEIPT") {
      return fail(
        "SESSION_KIND_MISMATCH",
        `session ${input.sessionId} is kind ${existing.kind}, not RECEIPT`
      );
    }
    const docAccess = await this.docService.getDocument(existing.documentId, input.memberId);
    if (!docAccess.ok) return docAccess;

    const merged: Record<string, string> = { ...existing.correctedPayload, ...input.patches };
    try {
      const updated = await this.reviewRepo.updateCorrectedPayload(input.sessionId, merged, "PENDING_REVIEW");
      return ok(updated);
    } catch (err) {
      if (err instanceof Error && /stale state/i.test(err.message)) {
        return fail("SESSION_NOT_PENDING", `session ${input.sessionId} is no longer PENDING_REVIEW`);
      }
      if (err instanceof Error && /mid-confirmation/i.test(err.message)) {
        return fail("SESSION_NOT_PENDING", `session ${input.sessionId} has a confirmation in progress`);
      }
      throw err;
    }
  }

  // ── Reject ─────────────────────────────────────────────────────────────────

  /**
   * Reject a PENDING_REVIEW session. Zero financial mutation occurs.
   * The session moves to the terminal REJECTED state. Reason is optional.
   */
  async reject(input: RejectInput): Promise<ServiceResult<ConfirmResult>> {
    if (!Number.isSafeInteger(input.sessionId) || input.sessionId <= 0) {
      return fail("INVALID_INPUT", "sessionId must be a positive safe integer");
    }
    if (!Number.isSafeInteger(input.memberId) || input.memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }

    const existing = await this.reviewRepo.findById(input.sessionId);
    if (existing === null) {
      return fail("SESSION_NOT_FOUND", `review session ${input.sessionId} not found`);
    }
    if (existing.status !== "PENDING_REVIEW") {
      return fail("SESSION_NOT_PENDING", `session ${input.sessionId} is ${existing.status}`);
    }
    if (existing.kind !== "RECEIPT") {
      return fail(
        "SESSION_KIND_MISMATCH",
        `session ${input.sessionId} is kind ${existing.kind}, not RECEIPT`
      );
    }
    const docAccess = await this.docService.getDocument(existing.documentId, input.memberId);
    if (!docAccess.ok) return docAccess;

    let result;
    try {
      result = await this.reviewRepo.rejectSession(input.sessionId, input.reason ?? null, "PENDING_REVIEW");
    } catch (err) {
      if (err instanceof Error) {
        if (/^SESSION_NOT_FOUND$/.test(err.message)) {
          return fail("SESSION_NOT_FOUND", `review session ${input.sessionId} not found`);
        }
        if (/^SESSION_NOT_PENDING$/.test(err.message)) {
          return fail("SESSION_NOT_PENDING", `session ${input.sessionId} is no longer PENDING_REVIEW`);
        }
        if (/^SESSION_CLAIMED$/.test(err.message)) {
          return fail("SESSION_NOT_PENDING", `session ${input.sessionId} has a confirmation in progress`);
        }
      }
      throw err;
    }
    return ok({
      session: result.session,
      transactionId: result.session.linkedTransactionId,
      depositId: result.session.depositId,
    });
  }

  // ── Confirm (RECEIPT) ──────────────────────────────────────────────────────

  /**
   * Confirm a RECEIPT review session: post a single INCOME/EXPENSE
   * transaction bound to the underlying document and lock the session
   * into CONFIRMED.
   *
   * The amount/date in the confirm input are the FINAL user-confirmed
   * facts. The OCR review gate is re-evaluated against these facts
   * (synthesizing an OcrExtractionResult with confidence=1.0); if the
   * user-confirmed set would itself fail the gate, we surface
   * REVIEW_GATE_FAILED before posting any transaction.
   */
  async confirmReceipt(input: ConfirmReceiptInput): Promise<ServiceResult<ConfirmResult>> {
    const validation = validateReceiptInput(input);
    if (!validation.ok) return validation;

    const memberCheck = await this.requireActiveMember(input.memberId);
    if (!memberCheck.ok) return memberCheck;

    const session = await this.reviewRepo.findById(input.sessionId);
    if (session === null) {
      return fail("SESSION_NOT_FOUND", `review session ${input.sessionId} not found`);
    }
    if (session.kind !== "RECEIPT") {
      return fail("SESSION_KIND_MISMATCH", `session ${input.sessionId} is kind ${session.kind}, not RECEIPT`);
    }
    if (session.status !== "PENDING_REVIEW") {
      return fail("SESSION_NOT_PENDING", `session ${input.sessionId} is ${session.status}`);
    }

    const docAccess = await this.docService.getDocument(session.documentId, input.memberId);
    if (!docAccess.ok) return docAccess;

    // Re-evaluate the OCR review gate against the FINAL user-confirmed
    // amount and date. The gate logic is the same shape as submit-time:
    // the synthesized candidate set has high confidence (user explicitly
    // confirmed), so the only way the gate can fail here is if the
    // user-confirmed facts themselves violate the gate (missing critical
    // candidate shape). We synthesize date confidence against an ISO
    // YYYY-MM-DD value so the gate accepts the user-confirmed date.
    const gateDecision = decideOcrReview({
      processingMs: 0,
      totalAmountCandidate: { value: String(input.amountMinor), confidence: 1 },
      dateCandidate: { value: input.occurredOn, confidence: 1 },
    });
    if (gateDecision.requiresReview) {
      return fail(
        "REVIEW_GATE_FAILED",
        `user-confirmed amount/date still fail the review gate: ${gateDecision.reasons.join("; ")}`
      );
    }

    // STEP 1: CLAIM the session's post_idempotency_key slot BEFORE any
    // financial write. This is the race-safe boundary that prevents two
    // concurrent callers with different idempotency keys from both
    // posting a transaction. The claim runs as an atomic UPDATE keyed
    // on (status='PENDING_REVIEW', post_idempotency_key IS NULL OR = ?).
    // A same-key retry is admitted (the transactions UNIQUE keeps the
    // retry a no-op at the financial layer); a different-key caller is
    // rejected with SESSION_CLAIM_CONFLICT before any transaction is
    // posted. The claim is retained across post failures — only a
    // same-key retry is admitted to recover, every other key remains
    // blocked.
    const claim = await this.reviewRepo.claimSession(input.sessionId, input.idempotencyKey);
    switch (claim.code) {
      case "CLAIMED":
      case "ALREADY_CLAIMED_SAME_KEY":
        // CLAIMED: fresh slot reserved for this idempotency key.
        // ALREADY_CLAIMED_SAME_KEY: a prior caller's post crashed mid-
        // write; we are admitted again to resume the flow. The claim
        // is intentionally retained — we never clear it from the
        // service. The transactions UNIQUE keeps the financial layer
        // idempotent across retries.
        break;
      case "ALREADY_CLAIMED_DIFFERENT_KEY":
        return fail(
          "SESSION_CLAIM_CONFLICT",
          `review session ${input.sessionId} is already claimed with a different post idempotency key`
        );
      case "NOT_PENDING":
        return fail("SESSION_NOT_PENDING", `session ${input.sessionId} is no longer PENDING_REVIEW`);
      case "KIND_MISMATCH":
        return fail("SESSION_KIND_MISMATCH", `session ${input.sessionId} is not a RECEIPT`);
      case "NOT_FOUND":
        return fail("SESSION_NOT_FOUND", `review session ${input.sessionId} not found`);
    }

    // STEP 2: Post the transaction. sourceEvidenceRef binds the ledger
    // row to the underlying document id (the M3A SPEC §6.2 audit
    // linkage). On any non-idempotent failure we DO NOT clear the
    // claim — the slot is intentionally retained so the same key can
    // retry to recover and every other key remains blocked.
    const postResult = await this.txService.postIncomeExpense("EXPENSE", {
      memberId: input.memberId,
      accountId: input.accountId,
      categoryId: input.categoryId,
      currencyCode: input.currencyCode,
      amountMinor: input.amountMinor,
      occurredOn: input.occurredOn,
      idempotencyKey: input.idempotencyKey,
      sourceEvidenceRef: `doc:${session.documentId}`,
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
    if (!postResult.ok) {
      return fail(mapTxPostError(postResult.error.code), postResult.error.message);
    }

    // STEP 3: Confirm the session, binding the post_idempotency_key to
    // the linked transaction. Defense in depth: if confirmSession still
    // throws DUPLICATE_IDEMPOTENCY_KEY (should not happen now that the
    // claim pre-empts the race, but kept as a safety net), re-find the
    // existing transaction so the retry is idempotent.
    let confirmResult;
    try {
      confirmResult = await this.reviewRepo.confirmSession(
        input.sessionId,
        {
          confirmedPayload: {
            amountMinor: input.amountMinor,
            occurredOn: input.occurredOn,
            accountId: input.accountId,
            categoryId: input.categoryId,
            currencyCode: input.currencyCode,
            description: input.description ?? null,
          },
          postIdempotencyKey: input.idempotencyKey,
          linkedTransactionId: postResult.value.transaction.id,
        },
        "PENDING_REVIEW",
        "RECEIPT"
      );
    } catch (err) {
      if (err instanceof Error && /^DUPLICATE_IDEMPOTENCY_KEY$/.test(err.message)) {
        // Re-find the session row: a concurrent caller with the same
        // idempotency key already confirmed it. Return the canonical
        // session + linked transaction so the retry is idempotent.
        const winner = await this.reviewRepo.findById(input.sessionId);
        if (winner !== null && winner.postIdempotencyKey === input.idempotencyKey) {
          return ok({
            session: winner,
            transactionId: winner.linkedTransactionId,
            depositId: winner.depositId,
          });
        }
        return fail(
          "DUPLICATE_IDEMPOTENCY_KEY",
          `idempotency key "${input.idempotencyKey}" already used by another review session`
        );
      }
      if (err instanceof Error) {
        if (/^SESSION_NOT_FOUND$/.test(err.message)) {
          return fail("SESSION_NOT_FOUND", `review session ${input.sessionId} not found`);
        }
        if (/^SESSION_NOT_PENDING$/.test(err.message)) {
          return fail("SESSION_NOT_PENDING", `session ${input.sessionId} is no longer PENDING_REVIEW`);
        }
        if (/^SESSION_KIND_MISMATCH$/.test(err.message)) {
          return fail("SESSION_KIND_MISMATCH", `session ${input.sessionId} is not a RECEIPT`);
        }
      }
      throw err;
    }

    return ok({
      session: confirmResult.session,
      transactionId: confirmResult.session.linkedTransactionId,
      depositId: confirmResult.session.depositId,
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async requireActiveMember(memberId: number): Promise<ServiceResult<true>> {
    const ctx = await this.accountRepo.loadMemberContext(memberId);
    if (ctx === null) {
      return fail("MEMBER_NOT_FOUND", `member ${memberId} not found`);
    }
    if (ctx.active !== 1) {
      return fail("MEMBER_INACTIVE", `member ${memberId} is inactive`);
    }
    return ok(true);
  }
}

// ── Pure validators ──────────────────────────────────────────────────────────

function validateReceiptInput(input: ConfirmReceiptInput): ServiceResult<true> {
  if (!Number.isSafeInteger(input.sessionId) || input.sessionId <= 0) {
    return fail("INVALID_INPUT", "sessionId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.memberId) || input.memberId <= 0) {
    return fail("INVALID_INPUT", "memberId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.accountId) || input.accountId <= 0) {
    return fail("INVALID_INPUT", "accountId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.categoryId) || input.categoryId <= 0) {
    return fail("INVALID_INPUT", "categoryId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    return fail("INVALID_INPUT", "amountMinor must be a positive safe integer");
  }
  if (typeof input.currencyCode !== "string" || input.currencyCode.length === 0) {
    return fail("INVALID_INPUT", "currencyCode must be a non-empty string");
  }
  if (typeof input.occurredOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)) {
    return fail("INVALID_INPUT", "occurredOn must be an ISO date (YYYY-MM-DD)");
  }
  const parsed = new Date(`${input.occurredOn}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input.occurredOn) {
    return fail("INVALID_INPUT", `occurredOn is not a valid calendar date (got ${input.occurredOn})`);
  }
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
    return fail("INVALID_INPUT", "idempotencyKey must be a non-empty string");
  }
  return ok(true);
}

// Maps the transactions ServiceErrorCode to the review ServiceErrorCode so
// the call site can return a ServiceResult<ConfirmResult> directly. The two
// enums overlap on the authorization and idempotency codes that
// postIncomeExpense surfaces in this path; codes that have no review-side
// equivalent (NOT_FOUND, CROSS_CURRENCY_REJECTED, IDEMPOTENCY_CONFLICT,
// TRANSACTION_NOT_FOUND, TRANSACTION_ALREADY_REVERSED) collapse to INTERNAL.
function mapTxPostError(code: TxServiceErrorCode): ServiceErrorCode {
  switch (code) {
    case "INVALID_INPUT":
    case "ACCOUNT_NOT_FOUND":
    case "ACCOUNT_INACTIVE":
    case "ACCOUNT_FORBIDDEN":
    case "CATEGORY_NOT_FOUND":
    case "CATEGORY_INACTIVE":
    case "MEMBER_NOT_FOUND":
    case "MEMBER_INACTIVE":
    case "CURRENCY_MISMATCH":
    case "DUPLICATE_IDEMPOTENCY_KEY":
    case "ILLEGAL_TRANSITION":
    case "INTERNAL":
      return code;
    default:
      return "INTERNAL";
  }
}
