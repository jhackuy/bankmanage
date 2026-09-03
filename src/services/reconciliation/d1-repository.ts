/**
 * D1 implementation of the reconciliation repository.
 *
 * All SQL is parameterized. No raw D1 binding escapes this module — the
 * application service sees only the abstract `ReconciliationRepository` port.
 *
 * Row mapping returns money columns directly. The TypeScript row type
 * guarantees they are numbers; SQLite INTEGER storage keeps them
 * lossless. No arithmetic happens in this layer.
 *
 * Cleared-balance computation: a single SQL SUM(CASE …) over
 * `ledger_entries` joined to `transactions`, filtered by account_id
 * and currency_code. Reversal transactions are included alongside
 * their originals so the pair sums to zero (mirrored entries cancel
 * each other out). Different currencies are never aggregated because
 * the WHERE clause enforces `e.currency_code = ?`.
 *
 * Idempotency: INSERT OR IGNORE on the UNIQUE `idempotency_key`
 * constraint. `meta.changes` from the write result tells the caller
 * whether THIS call inserted the row.
 */

import type { D1Database } from "../../adapters/d1/types.js";
import type {
  EnsureReconciliationInput,
  EnsureReconciliationResult,
  ReconciliationRepository,
} from "./repository.js";
import type { ReconciliationRecord } from "./types.js";

// ── Row type as stored in SQLite ────────────────────────────────────────────

interface ReconciliationRow {
  id: number;
  account_id: number;
  member_id: number;
  currency_code: string;
  bank_confirmed_balance_minor: number;
  cleared_balance_minor: number;
  difference_minor: number;
  confirmed_at: string;
  evidence_ref: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ReconciliationRow): ReconciliationRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    memberId: row.member_id,
    currencyCode: row.currency_code,
    bankConfirmedBalanceMinor: row.bank_confirmed_balance_minor,
    clearedBalanceMinor: row.cleared_balance_minor,
    differenceMinor: row.difference_minor,
    confirmedAt: row.confirmed_at,
    evidenceRef: row.evidence_ref,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── D1 Repository ───────────────────────────────────────────────────────────

export class D1ReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly db: D1Database) {}

  async ensureReconciliation(input: EnsureReconciliationInput): Promise<EnsureReconciliationResult> {
    // INSERT OR IGNORE then SELECT — the race-safe idempotency boundary.
    // SQLite's INSERT OR IGNORE on the UNIQUE idempotency_key constraint
    // leaves a duplicate attempt as a no-op, so the subsequent SELECT
    // always returns exactly one row.
    const write = await this.db
      .prepare(
        `INSERT OR IGNORE INTO account_reconciliations (
           account_id, member_id, currency_code,
           bank_confirmed_balance_minor, cleared_balance_minor, difference_minor,
           confirmed_at, evidence_ref, idempotency_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.accountId,
        input.memberId,
        input.currencyCode,
        input.bankConfirmedBalanceMinor,
        input.clearedBalanceMinor,
        input.differenceMinor,
        input.confirmedAt,
        input.evidenceRef,
        input.idempotencyKey
      )
      .run();
    // `created` is derived from the WRITE result, not a pre-read. The
    // UNIQUE constraint makes changes=1 mean "this statement inserted
    // the row" and changes=0 mean "another writer already owns it". A
    // pre-read cannot give this answer because a concurrent caller may
    // insert between read and write.
    const created = (write.meta.changes ?? 0) > 0;
    const row = await this.db
      .prepare(`SELECT * FROM account_reconciliations WHERE idempotency_key = ?`)
      .bind(input.idempotencyKey)
      .first<ReconciliationRow>();
    if (row === null) {
      // Should be unreachable: UNIQUE constraint guarantees the row
      // exists after INSERT OR IGNORE, but we surface a typed failure
      // rather than throw to keep the service-layer error path uniform.
      throw new Error(
        `ensureReconciliation: row missing after INSERT OR IGNORE for key=${input.idempotencyKey}`
      );
    }
    return { record: rowToRecord(row), created };
  }

  async findById(id: number): Promise<ReconciliationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM account_reconciliations WHERE id = ?")
      .bind(id)
      .first<ReconciliationRow>();
    return row === null ? null : rowToRecord(row);
  }

  async findByIdempotencyKey(key: string): Promise<ReconciliationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM account_reconciliations WHERE idempotency_key = ?")
      .bind(key)
      .first<ReconciliationRow>();
    return row === null ? null : rowToRecord(row);
  }

  async listForAccount(accountId: number, limit?: number): Promise<ReconciliationRecord[]> {
    const sql =
      limit === undefined
        ? `SELECT * FROM account_reconciliations
            WHERE account_id = ?
            ORDER BY confirmed_at DESC, id DESC`
        : `SELECT * FROM account_reconciliations
            WHERE account_id = ?
            ORDER BY confirmed_at DESC, id DESC
            LIMIT ?`;
    const stmt = this.db.prepare(sql).bind(...(limit === undefined ? [accountId] : [accountId, limit]));
    const result = await stmt.all<ReconciliationRow>();
    return result.results.map(rowToRecord);
  }

  async getLatestForAccount(accountId: number): Promise<ReconciliationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM account_reconciliations
          WHERE account_id = ?
          ORDER BY confirmed_at DESC, id DESC
          LIMIT 1`
      )
      .bind(accountId)
      .first<ReconciliationRow>();
    return row === null ? null : rowToRecord(row);
  }

  async computeClearedBalanceMinor(accountId: number, currencyCode: string): Promise<number> {
    // Deterministic cleared balance:
    //   opening_balance_minor
    //     + SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE -amount_minor END)
    // The accounts.opening_balance_minor is added via a correlated
    // scalar subquery, so a single round-trip is enough.
    //
    // Ledger entries are filtered by currency_code at the SQL level —
    // different currencies are never aggregated (SPEC §3 / §7). The
    // transactions service guarantees every ledger entry's
    // currency_code equals the account's currency_code, so this filter
    // is a defensive belt-and-braces against any future path that might
    // insert a mis-currency entry.
    //
    // Reversal transactions are included because their mirrored entries
    // cancel the original's entries — the pair sums to zero, preserving
    // the "balance after reversal = balance before original" invariant.
    const row = await this.db
      .prepare(
        `SELECT
            (SELECT opening_balance_minor FROM accounts WHERE id = ?)
              + COALESCE(SUM(
                CASE WHEN e.direction = 'DEBIT' THEN e.amount_minor ELSE -e.amount_minor END
              ), 0) AS cleared_minor
           FROM ledger_entries e
           WHERE e.account_id = ?
             AND e.currency_code = ?`
      )
      .bind(accountId, accountId, currencyCode)
      .first<{ cleared_minor: number }>();
    return row === null ? 0 : Number(row.cleared_minor);
  }
}
