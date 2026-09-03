/**
 * Transactions repository interface.
 *
 * Application service depends on this abstract port. The D1 adapter in
 * `./d1-repository.ts` provides the production implementation; tests use
 * the same port against the FakeD1Database binding.
 *
 * The repository is responsible for:
 *   - row-to-domain mapping (no JS floating point on money);
 *   - parameterized SQL only;
 *   - idempotent transaction + balanced entry insertion;
 *   - reversal linkage storage with race-safe UNIQUE constraints.
 *
 * The repository does NOT:
 *   - validate business invariants (those live in the application service);
 *   - physically delete transactions (SPEC §7 immutability);
 *   - compute balances or statistics (M2A leaves that to a future slice).
 */

import type { LedgerDirection, TransactionType } from "../../domain/ledger/index.js";
import type {
  LedgerEntryRecord,
  TransactionRecord,
  TransactionReversalRecord,
  TransactionWithEntries,
} from "./types.js";

/** Atomic insertion payload: the header + the 2 balanced entries. */
export interface PostTransactionPayload {
  readonly transaction: Omit<TransactionRecord, "id" | "state" | "createdAt" | "updatedAt">;
  readonly entries: readonly NewLedgerEntry[];
}

export interface NewLedgerEntry {
  readonly accountId: number | null;
  readonly categoryId: number | null;
  readonly direction: LedgerDirection;
  readonly amountMinor: number;
  readonly currencyCode: string;
  readonly memo?: string | null;
}

/** Result of an idempotent transaction insert. */
export interface PostTransactionResult {
  readonly transaction: TransactionRecord;
  readonly entries: readonly LedgerEntryRecord[];
  /**
   * `created` comes from the database WRITE result of this call, not from a
   * prior read. A duplicate idempotency_key returns the existing
   * transaction with `created: false`. This mirrors the reminder
   * repository's race-safe design.
   */
  readonly created: boolean;
}

export interface TransactionsRepository {
  /**
   * Atomically insert a transaction header and its balanced ledger entries.
   * If the idempotency_key already exists, return the existing transaction
   * with `created: false`. The header + entries are inserted in a single
   * D1 batch so either both succeed or neither does (atomicity boundary).
   */
  postTransaction(payload: PostTransactionPayload): Promise<PostTransactionResult>;

  /** SELECT a transaction by id. Returns null if no row matches. */
  findById(id: number): Promise<TransactionRecord | null>;

  /**
   * SELECT the transaction by idempotency_key. Returns null if no row
   * matches. Used by the application service to detect duplicates before
   * building the balanced entries (saves a batch on the no-op path).
   */
  findByIdempotencyKey(key: string): Promise<TransactionRecord | null>;

  /** SELECT every ledger entry belonging to a transaction, ordered by id ASC. */
  listEntriesByTransaction(transactionId: number): Promise<LedgerEntryRecord[]>;

  /** SELECT transactions for a member, optionally filtered by type and state. */
  listByMember(
    memberId: number,
    filter?: { readonly transactionType?: TransactionType; readonly state?: string }
  ): Promise<TransactionRecord[]>;

  /** Read the transaction + its balanced entries. */
  getWithEntries(id: number): Promise<TransactionWithEntries | null>;

  /**
   * Mark a transaction as REVERSED. Returns the updated row or null if
   * the row is no longer POSTED (race-safe boundary — a concurrent
   * reversal cannot move the state twice).
   */
  markReversed(id: number): Promise<TransactionRecord | null>;

  /** Insert a reversal linkage row. */
  insertReversal(
    originalTransactionId: number,
    reversalTransactionId: number,
    reversedByMemberId: number,
    reason: string | null
  ): Promise<TransactionReversalRecord>;

  /** Read the reversal row for an original transaction, if any. */
  findReversalForOriginal(originalTransactionId: number): Promise<TransactionReversalRecord | null>;

  /** Read the reversal row that points to a specific reversal transaction. */
  findReversalByReversalId(reversalTransactionId: number): Promise<TransactionReversalRecord | null>;
}
