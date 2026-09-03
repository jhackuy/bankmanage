/**
 * M2C reports application-service types.
 *
 * Platform-neutral types describing the report/statistics outputs the
 * dashboard and later presentation consumers see. Every monetary value
 * is integer minor units (SPEC §3/§7). Different currencies are never
 * silently summed 1:1 — every aggregate is grouped strictly by
 * currency.
 *
 * See SPEC.md §7 (ledger, reconciliation) and §8 (dashboard, reports).
 */

import type { AccountRecord } from "../accounts/types.js";
import type { ReconciliationRecord } from "../reconciliation/types.js";
import type { MaturityAllWindowsStats, MaturityWindowStats } from "../../domain/term-deposit/index.js";
import type { TransactionRecord } from "../transactions/types.js";

// Re-export reconciliation record so callers can type their results.
export type { ReconciliationRecord };

// ── Currency-bucketed rollups ───────────────────────────────────────────────

/**
 * Per-currency aggregate. Used by monthly income/expense/net, category
 * breakdowns and asset totals so the dashboard can render a row per
 * currency without ever adding currencies together.
 */
export interface CurrencyAmount {
  readonly currencyCode: string;
  readonly amountMinor: number;
}

/**
 * Multi-currency rollup keyed by currency. Sort order is the producer's
 * choice; the D1 repository always emits currency code ASC for stability.
 */
export interface CurrencyAmountList {
  readonly byCurrency: readonly CurrencyAmount[];
}

// ── Monthly income / expense / net ─────────────────────────────────────────

export interface MonthlyIncomeExpenseNet {
  /** First day of the month, inclusive (UTC, ISO YYYY-MM-DD). */
  readonly fromDate: string;
  /** First day of the next month, exclusive (UTC, ISO YYYY-MM-DD). */
  readonly toDate: string;
  /** Per-currency total of INCOME transactions in POSTED state. */
  readonly incomeByCurrency: readonly CurrencyAmount[];
  /** Per-currency total of EXPENSE transactions in POSTED state. */
  readonly expenseByCurrency: readonly CurrencyAmount[];
  /**
   * Per-currency net (income − expense) over the month. Computed
   * strictly within a single currency — different currencies are never
   * subtracted across each other.
   */
  readonly netByCurrency: readonly CurrencyAmount[];
}

// ── Expense category breakdown ─────────────────────────────────────────────

/**
 * One row of the expense breakdown. The `categoryId` is the drilldown
 * identifier a report consumer can use to list the underlying
 * transactions. `transactionCount` lets the dashboard render a count
 * without an extra round-trip; `totalAmountMinor` is the per-currency
 * total.
 */
export interface ExpenseCategoryBreakdownRow {
  readonly categoryId: number;
  readonly categoryName: string;
  readonly currencyCode: string;
  readonly totalAmountMinor: number;
  readonly transactionCount: number;
}

export interface ExpenseCategoryBreakdown {
  readonly fromDate: string;
  readonly toDate: string;
  readonly rows: readonly ExpenseCategoryBreakdownRow[];
}

// ── Bank / account totals ──────────────────────────────────────────────────

/**
 * Per-account bank/account rollup. Includes the latest reconciliation
 * status so the dashboard can render the "unreconciled" indicator
 * without a second query.
 */
export interface AccountTotal {
  readonly account: AccountRecord;
  /** Cleared ledger balance in integer minor units. */
  readonly clearedBalanceMinor: number;
  /** Latest reconciliation record, or null when the account has never been reconciled. */
  readonly latestReconciliation: ReconciliationRecord | null;
  /** True when the account has no reconciliation, or its current cleared ledger balance no longer matches the bank-confirmed balance from its latest reconciliation. */
  readonly unreconciled: boolean;
}

/**
 * Bank-and-currency rollup. Each row groups accounts belonging to one
 * bank, broken down by currency. Different currencies inside the same
 * bank are never summed.
 */
export interface BankCurrencyTotal {
  readonly bankId: number | null;
  readonly currencyCode: string;
  readonly accountCount: number;
  readonly totalBalanceMinor: number;
  readonly accounts: readonly AccountTotal[];
}

export interface BankCurrencyTotals {
  readonly byBankAndCurrency: readonly BankCurrencyTotal[];
}

// ── Recent transactions ────────────────────────────────────────────────────

/**
 * Recent posted transaction summary, respecting reversal/void semantics:
 * a transaction whose header is REVERSED is never returned. Reversal
 * transactions themselves are POSTED (they are real transactions that
 * balance the original) and may be returned when they fall inside the
 * recent window — the dashboard labels them "Reversal of #N" via the
 * stored description.
 */
export interface RecentTransaction {
  readonly transaction: TransactionRecord;
}

// ── Result types (mirror the existing ServiceResult convention) ────────────

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ServiceError };

export interface ServiceError {
  readonly code: ServiceErrorCode;
  readonly message: string;
}

export type ServiceErrorCode =
  | "INVALID_INPUT"
  | "MEMBER_NOT_FOUND"
  | "MEMBER_INACTIVE"
  | "MEMBER_FORBIDDEN"
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

// ── Re-export the maturity statistics shape so consumers can type against
//    one module without reaching into the term-deposit service. ────────────

export type { MaturityAllWindowsStats, MaturityWindowStats };
