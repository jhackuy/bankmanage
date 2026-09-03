/**
 * D1 implementation of the transactions repository.
 *
 * All SQL is parameterized. No raw D1 binding escapes this module — the
 * application service sees only the abstract `TransactionsRepository` port.
 *
 * Atomicity:
 *   The `postTransaction` method inserts the header + N balanced ledger
 *   entries via D1's batch() API. better-sqlite3 wraps each batch in a
 *   single SQLite transaction so the entire post is atomic: either the
 *   header AND all entries are persisted, or nothing is.
 *
 * Idempotency:
 *   The transactions.idempotency_key UNIQUE constraint is the race-safe
 *   boundary. A duplicate INSERT OR IGNORE on the key leaves the existing
 *   row in place; the subsequent SELECT returns it. The repository then
 *   returns the existing transaction with `created: false` so the caller
 *   can treat the retry as a no-op.
 */

import type { D1Database, D1PreparedStatement } from "../../adapters/d1/types.js";
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
    // Pre-check: if the key already exists, return the existing transaction
    // + its entries without touching the DB further. The race-safe boundary
    // is the INSERT OR IGNORE below; this pre-check is a fast-path.
    const existing = await this.findByIdempotencyKey(payload.transaction.idempotencyKey);
    if (existing !== null) {
      const entries = await this.listEntriesByTransaction(existing.id);
      return { transaction: existing, entries, created: false };
    }

    // 1. INSERT the transaction header with INSERT OR IGNORE so a
    //    concurrent insert slipped between the pre-check above and this
    //    write cannot raise a UNIQUE violation. RETURNING gives us the
    //    row's id in one round trip.
    const headerRow = await this.db
      .prepare(
        `INSERT OR IGNORE INTO transactions (
           transaction_type, member_id, currency_code, amount_minor,
           occurred_on, description, idempotency_key,
           source_evidence_ref
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .bind(
        payload.transaction.transactionType,
        payload.transaction.memberId,
        payload.transaction.currencyCode,
        payload.transaction.amountMinor,
        payload.transaction.occurredOn,
        payload.transaction.description ?? null,
        payload.transaction.idempotencyKey,
        payload.transaction.sourceEvidenceRef ?? null
      )
      .first<TransactionRow>();

    if (headerRow === null) {
      // INSERT OR IGNORE collided with a concurrent insert. Re-read by
      // idempotency_key and return the canonical record with created=false.
      const reRead = await this.findByIdempotencyKey(payload.transaction.idempotencyKey);
      if (reRead === null) {
        throw new Error("postTransaction: header insert collided and key not found");
      }
      const entries = await this.listEntriesByTransaction(reRead.id);
      return { transaction: reRead, entries, created: false };
    }
    const transactionId = headerRow.id;

    // 2. Build the ledger-entry INSERT statements and run them in a single
    //    D1 batch. better-sqlite3 wraps the batch in a SQLite transaction
    //    so the header + all entries are atomic: either every row lands
    //    or none do.
    const entryStmts: D1PreparedStatement[] = payload.entries.map((e) =>
      this.db
        .prepare(
          `INSERT INTO ledger_entries (
             transaction_id, account_id, category_id,
             direction, amount_minor, currency_code, memo
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          transactionId,
          e.accountId,
          e.categoryId,
          e.direction,
          e.amountMinor,
          e.currencyCode,
          e.memo ?? null
        )
    );

    await this.db.batch(entryStmts);

    // 3. Read back the canonical entries (the DB defaults for created_at
    //    are applied) and the canonical header.
    const entries = await this.listEntriesByTransaction(transactionId);
    if (entries.length !== payload.entries.length) {
      throw new Error(
        `postTransaction: expected ${payload.entries.length} ledger entries, got ${entries.length}`
      );
    }
    const canonical = await this.findById(transactionId);
    if (canonical === null) {
      throw new Error("postTransaction: header row missing after batch insert");
    }
    return { transaction: canonical, entries, created: true };
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
}
