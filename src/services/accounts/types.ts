/**
 * Accounts application-service types.
 *
 * Platform-neutral types describing the account entity as the application
 * service sees it. Money values are integer minor units (e.g. centavos for
 * PHP, minor_unit_scale = 2). The repository layer is responsible for
 * mapping between these types and SQLite rows.
 *
 * See SPEC.md §3.
 */

import type { AccountType } from "../../domain/ledger/index.js";

// ── Persisted account entity ─────────────────────────────────────────────────

/**
 * Full account record as exposed by the application service. The current
 * balance is derived from the balanced ledger entries + opening_balance_minor
 * — it is not stored on this row. Application services that need a balance
 * compute it via the ledger.
 */
export interface AccountRecord {
  readonly id: number;
  readonly memberId: number;
  readonly bankId: number | null;
  readonly currencyCode: string;
  readonly accountType: AccountType;
  readonly nickname: string;
  readonly openingBalanceMinor: number;
  readonly active: number;
  readonly archived: number;
  readonly lastReconciledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Linked parent context used by the application service for invariants. */
export interface AccountContext {
  readonly accountId: number;
  readonly memberId: number;
  readonly bankId: number | null;
  readonly currencyCode: string;
  readonly accountType: AccountType;
  readonly active: number;
  readonly archived: number;
}

export interface MemberContext {
  readonly memberId: number;
  readonly active: number;
}

export interface BankContext {
  readonly bankId: number;
  readonly active: number;
}

export interface CurrencyContext {
  readonly code: string;
  readonly active: number;
}

// ── Create input ─────────────────────────────────────────────────────────────

/**
 * Fields required to create a new account. The application service validates
 * account-type/bank linkage, member and currency existence, and active state.
 */
export interface CreateAccountInput {
  readonly memberId: number;
  readonly currencyCode: string;
  readonly accountType: AccountType;
  readonly nickname: string;
  readonly openingBalanceMinor: number;
  /** Required for BANK / CREDIT_CARD / TERM_DEPOSIT; optional for CASH / E_WALLET; disallowed for INTERNAL. */
  readonly bankId?: number;
}

// ── Patch input ──────────────────────────────────────────────────────────────

/**
 * Patchable account fields. member_id, currency_code and account_type are
 * intentionally NOT patchable: changing them would invalidate posted
 * ledger entries. To "change" them, deactivate the old account and create
 * a new one.
 */
export interface UpdateAccountPatch {
  readonly nickname?: string;
  readonly openingBalanceMinor?: number;
  readonly bankId?: number | null;
}

// ── Result types ─────────────────────────────────────────────────────────────

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
  | "MEMBER_NOT_FOUND"
  | "MEMBER_INACTIVE"
  | "BANK_NOT_FOUND"
  | "BANK_INACTIVE"
  | "CURRENCY_NOT_FOUND"
  | "CURRENCY_INACTIVE"
  | "ACCOUNT_NOT_FOUND"
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
