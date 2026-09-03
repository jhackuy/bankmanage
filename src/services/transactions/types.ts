/**
 * Transactions application-service types.
 *
 * Platform-neutral types describing the transaction header and balanced
 * ledger entries as the application service sees them.
 *
 * Money values are integer minor units. Every posted transaction balances
 * within a single currency. Transfers never count as income or expense
 * (their ledger entries have two account-side rows; income/expense have
 * one account-side row and one category-side row).
 *
 * See SPEC.md §7 (ledger and reconciliation), §3 (asset management).
 */

import type { LedgerDirection, TransactionState, TransactionType } from "../../domain/ledger/index.js";

/** Persisted transaction header row. */
export interface TransactionRecord {
  readonly id: number;
  readonly memberId: number;
  readonly transactionType: TransactionType;
  readonly currencyCode: string;
  readonly amountMinor: number;
  readonly occurredOn: string;
  readonly description: string | null;
  readonly idempotencyKey: string;
  readonly state: TransactionState;
  readonly sourceEvidenceRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One balanced side of a transaction. */
export interface LedgerEntryRecord {
  readonly id: number;
  readonly transactionId: number;
  readonly accountId: number | null;
  readonly categoryId: number | null;
  readonly direction: LedgerDirection;
  readonly amountMinor: number;
  readonly currencyCode: string;
  readonly memo: string | null;
  readonly createdAt: string;
}

/**
 * Transaction + ledger entries view returned by read-side queries.
 * Entries are ordered by id ASC for stable comparison in tests.
 */
export interface TransactionWithEntries {
  readonly transaction: TransactionRecord;
  readonly entries: readonly LedgerEntryRecord[];
}

/** Reversal linkage row (SPEC §7 — void/reversal semantics). */
export interface TransactionReversalRecord {
  readonly id: number;
  readonly originalTransactionId: number;
  readonly reversalTransactionId: number;
  readonly reason: string | null;
  readonly reversedByMemberId: number;
  readonly reversedAt: string;
}

// ── Posting inputs ──────────────────────────────────────────────────────────

/**
 * Posting input for INCOME / EXPENSE. For TRANSFER see `PostTransferInput`.
 *
 * `categoryId` is optional for INCOME (income-source categories) and
 * required for EXPENSE (expense categories per SPEC §6.1).
 */
export interface PostIncomeExpenseInput {
  readonly memberId: number;
  readonly accountId: number;
  readonly currencyCode: string;
  readonly amountMinor: number;
  readonly occurredOn: string;
  readonly idempotencyKey: string;
  readonly categoryId?: number;
  readonly description?: string;
  readonly sourceEvidenceRef?: string;
}

/** Posting input for a TRANSFER between two user accounts. */
export interface PostTransferInput {
  readonly memberId: number;
  readonly sourceAccountId: number;
  readonly destinationAccountId: number;
  readonly currencyCode: string;
  readonly amountMinor: number;
  readonly occurredOn: string;
  readonly idempotencyKey: string;
  readonly description?: string;
  readonly sourceEvidenceRef?: string;
}

/** Reversal input. */
export interface ReverseTransactionInput {
  readonly transactionId: number;
  readonly reversedByMemberId: number;
  readonly reason?: string;
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
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_INACTIVE"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_INACTIVE"
  | "MEMBER_NOT_FOUND"
  | "CURRENCY_MISMATCH"
  | "CROSS_CURRENCY_REJECTED"
  | "DUPLICATE_IDEMPOTENCY_KEY"
  | "TRANSACTION_NOT_FOUND"
  | "TRANSACTION_ALREADY_REVERSED"
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
