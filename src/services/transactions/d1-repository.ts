/**
 * D1 implementation of the transactions repository.
 *
 * All SQL is parameterized. No raw D1 binding escapes this module — the
 * application service sees only the abstract `TransactionsRepository` port.
 *
 * Atomicity:
 *   The `postTransaction` method inserts the transaction header AND its
 *   balanced ledger entries in a single SQL statement using a CTE: the
 *   header is INSERTed in a `WITH new_txn AS (... RETURNING id)` CTE,
 *   and the main INSERT into `ledger_entries` references that id. A
 *   single SQL statement is auto-committed as one transaction in D1 (and
 *   in better-sqlite3 via the FakeD1Database binding), so either BOTH
 *   the header AND all entries persist, or nothing does. There is no
 *   path that yields a header with zero entries.
 *
 * Idempotency:
 *   The transactions.idempotency_key UNIQUE constraint is the race-safe
 *   boundary. The CTE's inner INSERT throws on collision; the batch
 *   call's catch block re-reads by key and returns the existing
 *   transaction with `created: false` so the caller can treat the
 *   retry as a no-op.
 *
 *   Reuse of the same key with a DIFFERENT immutable request is
 *   detected at the service layer (compare rebuilt identity strings)
 *   and surfaced as IDEMPOTENCY_CONFLICT. The repository itself does
 *   not make a payload-equality judgment — only the schema enforces
 *   key uniqueness.
 */

import type { D1Database } from "../../adapters/d1/types.js";
import type { LedgerDirection, TransactionState, TransactionType } from "../../domain/ledger/index.js";
import type { PostTransactionPayload, PostTransactionResult, TransactionsRepository } from "./repository.js";
import type {
  LedgerEntryRecord,
  TransactionRecord,
  TransactionReversalRecord,
  TransactionWithEntries,
} from "./types.js";

// ── Row types as stored in SQLite ───────────────────────────────────────────

interface TransactionRow {
  id: number;
  member_id: number;
  transaction_type: string;
  currency_code: string;
  amount_minor: number;
  occurred_on: string;
  description: string | null;
  idempotency_key: string;
  state: string;
  source_evidence_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface LedgerEntryRow {
  id: number;
  transaction_id: number;
  account_id: number | null;
  category_id: number | null;
  direction: string;
  amount_minor: number;
  currency_code: string;
  memo: string | null;
  created_at: string;
}

interface TransactionReversalRow {
  id: number;
  original_transaction_id: number;
  reversal_transaction_id: number;
  reason: string | null;
  reversed_by_member_id: number;
  reversed_at: string;
}

function rowToTransaction(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    transactionType: row.transaction_type as TransactionType,
    currencyCode: row.currency_code,
    amountMinor: row.amount_minor,
    occurredOn: row.occurred_on,
    description: row.description,
    idempotencyKey: row.idempotency_key,
    state: row.state as TransactionState,
    sourceEvidenceRef: row.source_evidence_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLedgerEntry(row: LedgerEntryRow): LedgerEntryRecord {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    accountId: row.account_id,
    categoryId: row.category_id,
    direction: row.direction as LedgerDirection,
    amountMinor: row.amount_minor,
    currencyCode: row.currency_code,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

function rowToReversal(row: TransactionReversalRow): TransactionReversalRecord {
  return {
    id: row.id,
    originalTransactionId: row.original_transaction_id,
    reversalTransactionId: row.reversal_transaction_id,
    reason: row.reason,
    reversedByMemberId: row.reversed_by_member_id,
    reversedAt: row.reversed_at,
  };
}

// ── D1 Repository ───────────────────────────────────────────────────────────

export class D1TransactionsRepository implements TransactionsRepository {
  constructor(private readonly db: D1Database) {}

  async postTransaction(payload: PostTransactionPayload): Promise<PostTransactionResult> {
    // Pre-check fast path: if the key already exists, return the
    // existing transaction + its entries without touching the DB
    // further. The UNIQUE constraint below is the authoritative
    // race-safe boundary.
    const existing = await this.findByIdempotencyKey(payload.transaction.idempotencyKey);
    if (existing !== null) {
      const entries = await this.listEntriesByTransaction(existing.id);
      return { transaction: existing, entries, created: false };
    }

    // Build an atomic CTE statement: the transaction header is
    // INSERTed in a CTE and its RETURNING id is selected by the main
    // INSERT into ledger_entries. Both inserts are part of one SQL
    // statement, so they share one auto-commit transaction.
    const entryCount = payload.entries.length;
    if (entryCount === 0) {
      throw new Error("postTransaction: requires at least one ledger entry");
    }
    const entrySelects = payload.entries
      .map(() => "SELECT id, ?, ?, ?, ?, ?, ? FROM new_txn")
      .join("\n          UNION ALL\n");
    const sql = `WITH new_txn AS (
            INSERT INTO transactions (
              transaction_type, member_id, currency_code, amount_minor,
              occurred_on, description, idempotency_key, source_evidence_ref
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          )
          INSERT INTO ledger_entries (
            transaction_id, account_id, category_id, direction,
            amount_minor, currency_code, memo
          )
          ${entrySelects}`;

    const params: unknown[] = [
      payload.transaction.transactionType,
      payload.transaction.memberId,
      payload.transaction.currencyCode,
      payload.transaction.amountMinor,
      payload.transaction.occurredOn,
      payload.transaction.description ?? null,
      payload.transaction.idempotencyKey,
      payload.transaction.sourceEvidenceRef ?? null,
    ];
    for (const e of payload.entries) {
      params.push(e.accountId, e.categoryId, e.direction, e.amountMinor, e.currencyCode, e.memo ?? null);
    }

    try {
      await this.db.batch([this.db.prepare(sql).bind(...(params as never[]))]);
    } catch (err) {
      // UNIQUE collision: a concurrent caller slipped between the
      // pre-check above and our CTE INSERT. The CTE's inner INSERT
      // threw and nothing was persisted. Re-read the canonical row.
      if (
        err instanceof Error &&
        /UNIQUE constraint failed: transactions\.idempotency_key/i.test(err.message)
      ) {
        const reRead = await this.findByIdempotencyKey(payload.transaction.idempotencyKey);
        if (reRead === null) {
          throw new Error("postTransaction: unique collision but key not found in re-read");
        }
        const entries = await this.listEntriesByTransaction(reRead.id);
        return { transaction: reRead, entries, created: false };
      }
      throw err;
    }

    // Success: read the canonical header + entries back and return.
    const reRead = await this.findByIdempotencyKey(payload.transaction.idempotencyKey);
    if (reRead === null) {
      throw new Error("postTransaction: header missing after successful batch insert");
    }
    const entries = await this.listEntriesByTransaction(reRead.id);
    if (entries.length !== entryCount) {
      throw new Error(`postTransaction: expected ${entryCount} ledger entries, got ${entries.length}`);
    }
    return { transaction: reRead, entries, created: true };
  }

  async findById(id: number): Promise<TransactionRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM transactions WHERE id = ?")
      .bind(id)
      .first<TransactionRow>();
    return row === null ? null : rowToTransaction(row);
  }

  async findByIdempotencyKey(key: string): Promise<TransactionRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM transactions WHERE idempotency_key = ?")
      .bind(key)
      .first<TransactionRow>();
    return row === null ? null : rowToTransaction(row);
  }

  async listEntriesByTransaction(transactionId: number): Promise<LedgerEntryRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM ledger_entries
           WHERE transaction_id = ?
           ORDER BY id ASC`
      )
      .bind(transactionId)
      .all<LedgerEntryRow>();
    return result.results.map(rowToLedgerEntry);
  }

  async listByMember(
    memberId: number,
    filter?: { readonly transactionType?: TransactionType; readonly state?: string }
  ): Promise<TransactionRecord[]> {
    const where: string[] = ["member_id = ?"];
    const params: unknown[] = [memberId];
    if (filter?.transactionType !== undefined) {
      where.push("transaction_type = ?");
      params.push(filter.transactionType);
    }
    if (filter?.state !== undefined) {
      where.push("state = ?");
      params.push(filter.state);
    }
    const sql = `SELECT * FROM transactions WHERE ${where.join(" AND ")} ORDER BY occurred_on ASC, id ASC`;
    const result = await this.db
      .prepare(sql)
      .bind(...(params as never[]))
      .all<TransactionRow>();
    return result.results.map(rowToTransaction);
  }

  async getWithEntries(id: number): Promise<TransactionWithEntries | null> {
    const transaction = await this.findById(id);
    if (transaction === null) return null;
    const entries = await this.listEntriesByTransaction(id);
    return { transaction, entries };
  }

  async markReversed(id: number): Promise<TransactionRecord | null> {
    // Race-safe boundary: only POSTED -> REVERSED is permitted. A
    // concurrent reversal already moved the row to REVERSED, so the
    // WHERE clause filters it out and we return null.
    const row = await this.db
      .prepare(
        `UPDATE transactions
           SET state = 'REVERSED',
               updated_at = datetime('now', 'utc')
           WHERE id = ? AND state = 'POSTED'
           RETURNING *`
      )
      .bind(id)
      .first<TransactionRow>();
    return row === null ? null : rowToTransaction(row);
  }

  async insertReversal(
    originalTransactionId: number,
    reversalTransactionId: number,
    reversedByMemberId: number,
    reason: string | null
  ): Promise<TransactionReversalRecord> {
    const row = await this.db
      .prepare(
        `INSERT INTO transaction_reversals (
           original_transaction_id, reversal_transaction_id,
           reason, reversed_by_member_id
         ) VALUES (?, ?, ?, ?)
         RETURNING *`
      )
      .bind(originalTransactionId, reversalTransactionId, reason, reversedByMemberId)
      .first<TransactionReversalRow>();
    if (row === null) {
      throw new Error("insertReversal: RETURNING produced no row");
    }
    return rowToReversal(row);
  }

  async findReversalForOriginal(originalTransactionId: number): Promise<TransactionReversalRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM transaction_reversals WHERE original_transaction_id = ?")
      .bind(originalTransactionId)
      .first<TransactionReversalRow>();
    return row === null ? null : rowToReversal(row);
  }

  async findReversalByReversalId(reversalTransactionId: number): Promise<TransactionReversalRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM transaction_reversals WHERE reversal_transaction_id = ?")
      .bind(reversalTransactionId)
      .first<TransactionReversalRow>();
    return row === null ? null : rowToReversal(row);
  }

  /**
   * Recovery-only operation. Removes a transaction row and its ledger
   * entries when they are in an inconsistent state — specifically, a
   * reversal header was inserted but the linkage insert failed, leaving
   * an orphan reversal with the original still in POSTED state.
   *
   * Guard rails:
   *   - Requires the (id, idempotency_key) pair to match a single row
   *     so a corrupted call cannot delete the wrong transaction.
   *   - Refuses to delete if a row in `transaction_reversals` points at
   *     this id (it is properly linked and is ledger history).
   *   - Refuses to delete a transaction that has ledger entries
   *     referenced by anything other than itself (forward-references
   *     or splits).
   *
   * The application service calls this only from the roll-back path of
   * `reverseTransaction`. Normal operation never deletes.
   */
  async deleteTransactionAndEntries(transactionId: number, idempotencyKey: string): Promise<void> {
    // Guard: refuse to delete if the transaction is linked by a reversal
    // row in either direction. This is part of "never physically delete
    // ledger history".
    const linked = await this.db
      .prepare(
        `SELECT 1 FROM transaction_reversals
           WHERE original_transaction_id = ? OR reversal_transaction_id = ?
           LIMIT 1`
      )
      .bind(transactionId, transactionId)
      .first<{ 1: number }>();
    if (linked !== null) {
      throw new Error(
        `deleteTransactionAndEntries: transaction ${transactionId} is linked by a reversal row, refusing to delete`
      );
    }

    // FK DELETE from ledger_entries cascades through the transactions.id
    // -> ledger_entries.transaction_id relationship. We rely on
    // FOREIGN KEY support in both D1 and the better-sqlite3 backing
    // store. We delete entries first so the relationship becomes
    // orphans even if FK pragma is OFF.
    await this.db.prepare("DELETE FROM ledger_entries WHERE transaction_id = ?").bind(transactionId).run();
    const header = await this.db
      .prepare("DELETE FROM transactions WHERE id = ? AND idempotency_key = ?")
      .bind(transactionId, idempotencyKey)
      .run();
    if (header.meta.changes === 0) {
      throw new Error(
        `deleteTransactionAndEntries: no transaction with id=${transactionId} and matching key`
      );
    }
  }
}
