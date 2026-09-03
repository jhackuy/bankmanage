/**
 * Transactions application-service barrel.
 *
 * Re-exports the public surface of the M2A transactions slice: the
 * repository port, the D1 adapter, the application service, and the
 * platform-neutral types.
 */

export {
  type TransactionsRepository,
  type PostTransactionPayload,
  type PostTransactionResult,
  type NewLedgerEntry,
} from "./repository.js";

export { D1TransactionsRepository } from "./d1-repository.js";

export { TransactionApplicationService } from "./service.js";

export {
  type LedgerEntryRecord,
  type PostIncomeExpenseInput,
  type PostTransferInput,
  type ReverseTransactionInput,
  type ServiceError,
  type ServiceErrorCode,
  type ServiceResult,
  type TransactionRecord,
  type TransactionReversalRecord,
  type TransactionWithEntries,
  fail,
  ok,
  serviceError,
} from "./types.js";
