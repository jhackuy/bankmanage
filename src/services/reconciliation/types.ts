/**
 * Reconciliation application-service types.
 *
 * Platform-neutral types describing reconciliation records as the
 * application service sees them. Money values are integer minor units;
 * different currencies are never aggregated (SPEC §3 / §7).
 *
 * See SPEC.md §7 (ledger and reconciliation).
 */

import type { AccountRecord } from "../accounts/types.js";

// ── Persisted reconciliation entity ──────────────────────────────────────────

/**
 * Full reconciliation record as exposed by the application service.
 *
 * `clearedBalanceMinor` and `differenceMinor` are deterministic snapshots
 * computed at write time from the account's opening_balance_minor plus
 * the summed ledger entries. They are stored on the row so historical
 * audit reflects what was true at the moment of confirmation, even if
 * later ledger entries are posted against the same account.
 *
 * `differenceMinor` may be 0 (exact match), positive (bank says more than
 * ledger), or negative (bank says less than ledger). The application
 * service surfaces the explicit difference and never silently creates
 * an adjustment transaction.
 */
export interface ReconciliationRecord {
  readonly id: number;
  readonly accountId: number;
  readonly memberId: number;
  readonly currencyCode: string;
  readonly bankConfirmedBalanceMinor: number;
  readonly clearedBalanceMinor: number;
  readonly differenceMinor: number;
  readonly confirmedAt: string;
  readonly evidenceRef: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A reconciliation record paired with the account it belongs to.
 * Returned by the unreconciled-accounts query so callers don't need a
 * second round-trip to resolve the account_id.
 */
export interface UnreconciledAccount {
  readonly account: AccountRecord;
  /** null when the account has never been reconciled. */
  readonly latestReconciliation: ReconciliationRecord | null;
}

// ── Posting input ───────────────────────────────────────────────────────────

/**
 * Fields required to record a reconciliation.
 *
 * `currencyCode` is the currency the caller reports the bank-confirmed
 * balance in. The service validates that it matches the linked account's
 * currency — cross-currency reconciliations are rejected with
 * CURRENCY_MISMATCH because the cleared balance is computed only in the
 * account's currency (SPEC §7 "different currencies are never
 * aggregated"). When omitted, the account's currency is assumed.
 *
 * `confirmedAt` is a strict ISO-8601 datetime string
 * ("YYYY-MM-DDTHH:MM:SS[.sss][Z|±HH:MM]"). The application service
 * validates it as a real instant in time and canonicalizes it to
 * UTC ("YYYY-MM-DDTHH:MM:SS.sssZ") before persistence so mixed-offset
 * instants order correctly in SQL string comparisons.
 */
export interface PostReconciliationInput {
  readonly memberId: number;
  readonly accountId: number;
  readonly currencyCode?: string;
  readonly bankConfirmedBalanceMinor: number;
  readonly confirmedAt: string;
  readonly evidenceRef?: string;
  readonly idempotencyKey: string;
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
  | "ACCOUNT_FORBIDDEN"
  | "MEMBER_NOT_FOUND"
  | "MEMBER_INACTIVE"
  | "CURRENCY_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
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
