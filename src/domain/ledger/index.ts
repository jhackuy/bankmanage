/**
 * M2A domain barrel.
 *
 * Re-exports platform-neutral types used by the accounts / categories /
 * transactions services.
 */

export {
  ACCOUNT_TYPES,
  ACCOUNT_TYPES_REQUIRING_BANK,
  LEDGER_DIRECTIONS,
  TRANSACTION_STATES,
  TRANSACTION_TYPES,
  type AccountType,
  type LedgerDirection,
  type TransactionState,
  type TransactionType,
} from "./types.js";
