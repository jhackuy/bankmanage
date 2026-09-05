/**
 * Review-flow application-service types.
 *
 * Platform-neutral types describing the M3C review session as the
 * application service sees it. The repository layer owns the SQL
 * mapping; this file only describes the domain contract.
 *
 * SPEC §6.2 + §12 contract enforced here:
 *   "OCR output is always a candidate, never a financial source of
 *    truth." A review session stores user-confirmed facts in
 *    `confirmedPayload`; only that field set is ever used to authorize
 *    a downstream financial write. `candidatePayload` and
 *    `correctedPayload` are advisory-only.
 *
 * See AGENTS.md §2 and §3 for the OCR-is-never-truth invariant.
 */

import type { OcrReviewDecision } from "../../adapters/ocr/confidence.js";
import type { OcrExtractionResult } from "../../adapters/ocr/interface.js";
import type { DayCountBasis, InterestMethod, MaturityInstruction } from "../../domain/term-deposit/index.js";

// ── Session-kind and status ──────────────────────────────────────────────────

export type ReviewKind = "RECEIPT" | "DEPOSIT" | "SETTLEMENT";

export const REVIEW_KINDS: readonly ReviewKind[] = ["RECEIPT", "DEPOSIT", "SETTLEMENT"] as const;

export type ReviewStatus = "PENDING_REVIEW" | "CONFIRMED" | "REJECTED";

// ── Persisted review-session entity ──────────────────────────────────────────

/**
 * A review session as exposed by the application service.
 *
 * Lifecycle:
 *   - PENDING_REVIEW → CONFIRMED   (one of confirmReceipt / confirmDeposit
 *                                  / confirmSettlement); CONFIRMED is
 *                                  terminal; `confirmedPayload` is non-null
 *                                  and `postIdempotencyKey` is set.
 *   - PENDING_REVIEW → REJECTED    (reject()); REJECTED is terminal;
 *                                  `confirmedPayload` stays null; zero
 *                                  financial mutation has occurred.
 *
 * The `linkedTransactionId` is populated only when the confirm step
 * produced a financial write (RECEIPT transactions, SETTLEMENT ledger
 * transfer). For DEPOSIT confirms, the write is a term_deposits row
 * referenced by `depositId` instead.
 */
export interface ReviewSessionRecord {
  readonly id: number;
  readonly kind: ReviewKind;
  readonly status: ReviewStatus;
  readonly documentId: number;
  readonly depositId: number | null;
  readonly confirmingMemberId: number;
  readonly reviewDecision: OcrReviewDecision;
  readonly candidatePayload: OcrExtractionResult;
  readonly correctedPayload: Readonly<Record<string, string>>;
  readonly confirmedPayload: Readonly<Record<string, unknown>> | null;
  readonly postIdempotencyKey: string | null;
  readonly linkedTransactionId: number | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Session input / output types ─────────────────────────────────────────────

/**
 * Input to `submitForReview`. The service applies the OCR review gate
 * and never auto-posts. The caller has already uploaded the document via
 * DocumentApplicationService and passes the document id here.
 */
export interface SubmitForReviewInput {
  readonly documentId: number;
  readonly ocrResult: OcrExtractionResult;
  readonly confirmingMemberId: number;
  /** DEPOSIT and SETTLEMENT sessions require linking the existing term
   *  deposit that the candidate belongs to. RECEIPT sessions leave this
   *  null at submit time and confirmReceipt confirms the account/category
   *  before posting the transaction. */
  readonly depositId?: number;
  /** A short reason supplied by the caller for logging/audit purposes. */
  readonly reason?: string;
}

export interface ReviewSessionView {
  readonly session: ReviewSessionRecord;
  /** True when the OCR review gate decided the candidate set is
   *  acceptable for direct confirmation WITHOUT requiring user edits. */
  readonly gateAcceptable: boolean;
}

/**
 * Patch for the `correctedPayload` of a PENDING_REVIEW session. Only
 * fields present in this input are updated; absent fields keep their
 * current value. The corrected payload is advisory — it is NOT used for
 * the financial write directly. The confirm input is.
 */
export interface CorrectFieldsInput {
  readonly sessionId: number;
  readonly memberId: number;
  readonly patches: Readonly<Record<string, string>>;
}

/**
 * Input to `ReviewSessionRepository.insertSession`. Domain-shaped input
 * describing a new PENDING_REVIEW session row.
 */
export interface InsertReviewSessionInput {
  readonly kind: ReviewKind;
  readonly documentId: number;
  readonly depositId: number | null;
  readonly confirmingMemberId: number;
  readonly reviewDecision: OcrReviewDecision;
  readonly candidatePayload: OcrExtractionResult;
  readonly correctedPayload: Readonly<Record<string, string>>;
  readonly reason: string | null;
}

/**
 * Patch passed to `ReviewSessionRepository.confirmSession`. The
 * confirmed payload is the user-confirmed fact set that will be used
 * downstream — not the OCR candidate.
 */
export interface ConfirmPatch {
  readonly confirmedPayload: Readonly<Record<string, unknown>>;
  readonly postIdempotencyKey: string;
  readonly linkedTransactionId: number | null;
}

/**
 * Input for `confirmReceipt`. The user must select an account and
 * category; the corrected receipt value set is committed in
 * `confirmedPayload` and a single POSTED transaction row is created
 * with `source_evidence_ref = "doc:" + documentId`. The memberId is
 * re-validated for authorization, and the review gate is re-evaluated
 * against the FINAL amount/date — corrections cannot bypass the gate.
 */
export interface ConfirmReceiptInput {
  readonly sessionId: number;
  readonly memberId: number;
  readonly accountId: number;
  readonly categoryId: number;
  /** User-confirmed amount in integer minor units (e.g. centavos). */
  readonly amountMinor: number;
  /** User-confirmed ISO calendar date (YYYY-MM-DD). */
  readonly occurredOn: string;
  readonly currencyCode: string;
  readonly description?: string;
  readonly idempotencyKey: string;
}

/**
 * Input for `confirmDeposit`. The user-corrected term-deposit facts are
 * passed here and a DRAFT term_deposits row is inserted with
 * `source_evidence_ref = "doc:" + documentId`.
 */
export interface ConfirmDepositInput {
  readonly sessionId: number;
  readonly memberId: number;
  readonly accountId: number;
  readonly bankId: number;
  readonly currencyCode: string;
  readonly productName: string;
  readonly certificateLastFour: string;
  readonly principalMinor: number;
  readonly startDate: string;
  readonly maturityDate: string;
  readonly annualRateScaled: number;
  readonly taxRateScaled: number;
  readonly feesMinor: number;
  readonly interestMethod: InterestMethod;
  readonly dayCountBasis: DayCountBasis;
  readonly nickname?: string;
  readonly maturityInstruction?: MaturityInstruction;
  readonly maturitySettlementAccountId?: number;
  readonly idempotencyKey: string;
}

/**
 * Input for `confirmSettlement`. The user-corrected settlement facts are
 * passed here; the service posts a balanced TRANSFER (TD account →
 * settlement account) for actualReceivedTotal and updates the term
 * deposit's `settlement_evidence_ref` to the document id.
 *
 * `actualGrossInterestMinor`, `actualTaxMinor`, and
 * `actualPenaltyFeesMinor` are advisory metadata recorded on the
 * session; only `actualReceivedTotalMinor` drives the ledger write.
 */
export interface ConfirmSettlementInput {
  readonly sessionId: number;
  readonly memberId: number;
  readonly settlementAccountId: number;
  readonly actualSettlementDate: string;
  readonly actualReceivedTotalMinor: number;
  readonly actualGrossInterestMinor: number;
  readonly actualTaxMinor: number;
  readonly actualPenaltyFeesMinor: number;
  readonly idempotencyKey: string;
}

export interface ConfirmResult {
  readonly session: ReviewSessionRecord;
  readonly transactionId: number | null;
  readonly depositId: number | null;
}

export interface RejectInput {
  readonly sessionId: number;
  readonly memberId: number;
  readonly reason?: string;
}

// ── Result types (mirror of other services) ──────────────────────────────────

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ServiceError };

export interface ServiceError {
  readonly code: ServiceErrorCode;
  readonly message: string;
}

export type ServiceErrorCode =
  | "INVALID_INPUT"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_PENDING"
  | "SESSION_KIND_MISMATCH"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_FORBIDDEN"
  | "MEMBER_NOT_FOUND"
  | "MEMBER_INACTIVE"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_INACTIVE"
  | "ACCOUNT_FORBIDDEN"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_INACTIVE"
  | "CURRENCY_MISMATCH"
  | "DEPOSIT_NOT_FOUND"
  | "REVIEW_GATE_FAILED"
  | "DUPLICATE_IDEMPOTENCY_KEY"
  | "SESSION_CLAIM_CONFLICT"
  | "ILLEGAL_TRANSITION"
  | "INTERNAL";

export function serviceError(code: ServiceErrorCode, message: string): ServiceError {
  return { code, message };
}

export function ok<T>(value: T): ServiceResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ServiceErrorCode, message: string): ServiceResult<T> {
  return { ok: false, error: { code, message } };
}
