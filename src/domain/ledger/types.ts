/**
 * M2A domain types — accounts, categories, transactions and balanced ledger.
 *
 * Platform-neutral: NO Hono, NO D1, NO R2, NO Telegram, NO UI imports. These
 * types are the single source of truth shared by the D1 schema
 * (migration 0006), the application service, the repositories and the
 * (future) HTTP handlers.
 *
 * See SPEC.md §3 (accounts), §6.1 (categories/favorites), §7 (ledger and
 * reconciliation).
 */

/** Account types allowed by SPEC §3. Mirrors the CHECK constraint. */
export type AccountType = "BANK" | "CASH" | "E_WALLET" | "CREDIT_CARD" | "TERM_DEPOSIT" | "INTERNAL";

export const ACCOUNT_TYPES: readonly AccountType[] = [
  "BANK",
  "CASH",
  "E_WALLET",
  "CREDIT_CARD",
  "TERM_DEPOSIT",
  "INTERNAL",
];

/**
 * Account types that require a `bank_id` reference. CASH and E_WALLET can
 * optionally carry a bank (e.g. GCash is associated with CIMB); INTERNAL
 * is a virtual offset account and never carries a bank reference.
 */
export const ACCOUNT_TYPES_REQUIRING_BANK: ReadonlySet<AccountType> = new Set([
  "BANK",
  "CREDIT_CARD",
  "TERM_DEPOSIT",
]);

/** Transaction posting types per SPEC §7. */
export type TransactionType = "INCOME" | "EXPENSE" | "TRANSFER";

export const TRANSACTION_TYPES: readonly TransactionType[] = ["INCOME", "EXPENSE", "TRANSFER"];

/**
 * Ledger entry direction. Each transaction has 2 entries: one DEBIT and
 * one CREDIT, balancing within a single currency.
 *
 * Semantics per SPEC §7:
 *   - INCOME: account side is DEBIT (balance up), category side is CREDIT.
 *   - EXPENSE: account side is CREDIT (balance down), category side is DEBIT.
 *   - TRANSFER: source account is CREDIT, destination account is DEBIT.
 */
export type LedgerDirection = "DEBIT" | "CREDIT";

export const LEDGER_DIRECTIONS: readonly LedgerDirection[] = ["DEBIT", "CREDIT"];

/** Transaction lifecycle states. */
export type TransactionState = "POSTED" | "REVERSED";

export const TRANSACTION_STATES: readonly TransactionState[] = ["POSTED", "REVERSED"];
