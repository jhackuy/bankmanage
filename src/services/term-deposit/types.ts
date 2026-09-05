/**
 * Term-deposit application-service types and errors.
 *
 * Platform-neutral types describing the domain entity as the application
 * service sees it. The repository layer is responsible for mapping between
 * these types and SQLite rows. No D1/Hono/UI imports allowed.
 *
 * See SPEC.md §3, §4.1, §4.2 and §4.3.
 */

import type {
  DayCountBasis,
  InterestEstimate,
  InterestMethod,
  MaturityInstruction,
  TermDepositState,
} from "../../domain/term-deposit/index.js";

// ── Persisted term-deposit entity ───────────────────────────────────────────

/**
 * Full term-deposit record as exposed by the application service. All
 * numeric fields are safe integers in minor units or scaled rate units.
 * Dates are strict ISO 'YYYY-MM-DD'.
 */
export interface TermDepositRecord {
  readonly id: number;
  readonly accountId: number;
  readonly bankId: number;
  readonly holderMemberId: number;
  readonly currencyCode: string;
  readonly productName: string;
  readonly nickname: string | null;
  readonly certificateLastFour: string;
  readonly principalMinor: number;
  readonly startDate: string;
  readonly maturityDate: string;
  readonly annualRateScaled: number;
  readonly taxRateScaled: number;
  readonly feesMinor: number;
  readonly interestMethod: InterestMethod;
  readonly dayCountBasis: DayCountBasis;
  readonly state: TermDepositState;
  readonly bankQuotedGrossInterestMinor: number | null;
  readonly bankQuotedNetInterestMinor: number | null;
  readonly bankQuotedMaturityAmountMinor: number | null;
  readonly maturityInstruction: MaturityInstruction;
  readonly maturitySettlementAccountId: number | null;
  readonly predecessorDepositId: number | null;
  readonly successorDepositId: number | null;
  readonly sourceEvidenceRef: string | null;
  readonly settlementEvidenceRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * System-computed interest estimate returned alongside a record. Computed
 * by the M1A calculator, never read from the DB. Bank-quoted facts are NOT
 * substituted for this value.
 */
export interface TermDepositWithEstimate {
  readonly record: TermDepositRecord;
  readonly estimate: InterestEstimate;
}

// ── Draft / patch inputs ────────────────────────────────────────────────────

/**
 * Fields required to create a new DRAFT term deposit. The application
 * service validates certificate privacy, account/member/bank/currency
 * consistency, COMPOUND rejection, and rate/date bounds before persistence.
 */
export interface CreateDraftInput {
  readonly accountId: number;
  readonly bankId: number;
  readonly holderMemberId: number;
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
  readonly predecessorDepositId?: number;
  readonly sourceEvidenceRef?: string;
  readonly bankQuotedGrossInterestMinor?: number;
  readonly bankQuotedNetInterestMinor?: number;
  readonly bankQuotedMaturityAmountMinor?: number;
}

/**
 * Editable draft/review facts. Linkage columns (account/bank/member/currency)
 * and the lifecycle state are intentionally NOT patchable here. Editing
 * them requires cancel + create (out of M1B scope).
 */
export interface EditableFactsPatch {
  readonly productName?: string;
  readonly nickname?: string | null;
  readonly certificateLastFour?: string;
  readonly principalMinor?: number;
  readonly startDate?: string;
  readonly maturityDate?: string;
  readonly annualRateScaled?: number;
  readonly taxRateScaled?: number;
  readonly feesMinor?: number;
  readonly interestMethod?: InterestMethod;
  readonly dayCountBasis?: DayCountBasis;
  readonly maturityInstruction?: MaturityInstruction;
  readonly maturitySettlementAccountId?: number | null;
  readonly sourceEvidenceRef?: string | null;
}

/**
 * Bank-quoted contractual facts. These are informational only; they must
 * NEVER alter the deterministic system estimate.
 */
export interface BankQuotedPatch {
  readonly bankQuotedGrossInterestMinor?: number | null;
  readonly bankQuotedNetInterestMinor?: number | null;
  readonly bankQuotedMaturityAmountMinor?: number | null;
}

// ── Result types ────────────────────────────────────────────────────────────

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ServiceError };

export interface ServiceError {
  readonly code: ServiceErrorCode;
  readonly message: string;
}

export type ServiceErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "ACCOUNT_TYPE_MISMATCH"
  | "ACCOUNT_LINKAGE_MISMATCH"
  | "MEMBER_NOT_FOUND"
  | "BANK_NOT_FOUND"
  | "CURRENCY_NOT_FOUND"
  | "DEPOSIT_NOT_FOUND"
  | "PREDECESSOR_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "STALE_STATE"
  | "DUPLICATE_LINK"
  | "DUPLICATE_IDEMPOTENCY_KEY"
  | "OVERFLOW"
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
