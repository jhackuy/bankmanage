/**
 * D1 implementation of the reports repository.
 *
 * All SQL is parameterized. No raw D1 binding escapes this module — the
 * application service sees only the abstract `ReportsRepository` port.
 *
 * Aggregation rules (SPEC §3 / §7 / §8):
 *   - All monetary columns are INTEGER minor units.
 *   - Every aggregate is GROUP BY currency_code; the application
 *     service never collapses across currencies.
 *   - REVERSED transaction headers are filtered out at the SQL level so
 *     voided transactions are excluded from income/expense/category
 *     totals. Reversal transactions themselves have state = 'POSTED'
 *     and are NOT auto-excluded — but their entries' direction is
 *     opposite to the original, so they are accounted for in their
 *     own right if the caller posts one inside the window.
 *   - TRANSFER rows are excluded from income/expense totals because
 *     they have no category-side entry; the structural check is
 *     `category_id IS NOT NULL` on the account side (or simply:
 *     transaction_type IN ('INCOME', 'EXPENSE')).
 *   - Cleared balance computation mirrors the reconciliation repository
 *     so the dashboard never diverges from the reconciliation record.
 */

import type { D1Database } from "../../adapters/d1/types.js";
import type { AccountRecord } from "../accounts/types.js";
import type { ReconciliationRecord } from "../reconciliation/types.js";
import type { TransactionRecord } from "../transactions/types.js";
import type { ReportsRepository } from "./repository.js";
import type { CurrencyAmount, ExpenseCategoryBreakdownRow } from "./types.js";

// ── Row types as stored in SQLite ───────────────────────────────────────────

interface AccountRow {
  id: number;
  member_id: number;
  bank_id: number | null;
  currency_code: string;
  account_type: string;
  nickname: string;
  opening_balance_minor: number;
  active: number;
  archived: number;
  last_reconciled_at: string | null;
  created_at: string;
  updated_at: string;
}

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
  currency_declared: number;
  created_at: string;
  updated_at: string;
}

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

interface CategoryRollupRow {
  category_id: number;
  category_name: string;
  currency_code: string;
  total_amount_minor: number;
  transaction_count: number;
}

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    bankId: row.bank_id,
    currencyCode: row.currency_code,
    accountType: row.account_type as AccountRecord["accountType"],
    nickname: row.nickname,
    openingBalanceMinor: row.opening_balance_minor,
    active: row.active,
    archived: row.archived,
    lastReconciledAt: row.last_reconciled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToReconciliation(row: ReconciliationRow): ReconciliationRecord {
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
    currencyDeclared: row.currency_declared === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTransaction(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    transactionType: row.transaction_type as TransactionRecord["transactionType"],
    currencyCode: row.currency_code,
    amountMinor: row.amount_minor,
    occurredOn: row.occurred_on,
    description: row.description,
    idempotencyKey: row.idempotency_key,
    state: row.state as TransactionRecord["state"],
    sourceEvidenceRef: row.source_evidence_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── D1 Repository ───────────────────────────────────────────────────────────

export class D1ReportsRepository implements ReportsRepository {
  constructor(private readonly db: D1Database) {}

  async aggregateMonthlyIncomeExpense(
    fromDate: string,
    toDate: string
  ): Promise<{
    readonly incomeByCurrency: readonly CurrencyAmount[];
    readonly expenseByCurrency: readonly CurrencyAmount[];
  }> {
    // We aggregate from the transactions header joined to the category-side
    // ledger_entries row. The `category_id IS NOT NULL` predicate is the
    // structural signal that distinguishes INCOME/EXPENSE from TRANSFER
    // (transfers have two account-side entries, no category-side entry).
    //
    // The SUM is over the category-side amount_minor only, which equals
    // the transaction's amount_minor (the two sides balance). Filtering
    // on `state = 'POSTED'` excludes REVERSED headers. Grouping by both
    // transaction_type and currency_code keeps the two streams separate.
    const result = await this.db
      .prepare(
        `SELECT t.transaction_type AS transaction_type,
                t.currency_code     AS currency_code,
                SUM(e.amount_minor) AS total_minor
           FROM transactions t
           JOIN ledger_entries e ON e.transaction_id = t.id
          WHERE t.state = 'POSTED'
            AND t.transaction_type IN ('INCOME', 'EXPENSE')
            AND e.category_id IS NOT NULL
            AND t.occurred_on >= ?
            AND t.occurred_on <  ?
          GROUP BY t.transaction_type, t.currency_code
          ORDER BY t.currency_code ASC`
      )
      .bind(fromDate, toDate)
      .all<{ transaction_type: string; currency_code: string; total_minor: number }>();

    const incomeByCurrency: CurrencyAmount[] = [];
    const expenseByCurrency: CurrencyAmount[] = [];
    for (const row of result.results) {
      const total = Number(row.total_minor);
      if (!Number.isSafeInteger(total)) {
        // Defensive: SQLite INTEGER is always safe, but we guard the
        // boundary so a future migration to a non-INTEGER column cannot
        // silently corrupt the dashboard.
        throw new Error(
          `aggregateMonthlyIncomeExpense: total ${total} for ${row.currency_code} is outside the safe-integer range`
        );
      }
      const entry: CurrencyAmount = { currencyCode: row.currency_code, amountMinor: total };
      if (row.transaction_type === "INCOME") {
        incomeByCurrency.push(entry);
      } else {
        expenseByCurrency.push(entry);
      }
    }
    return { incomeByCurrency, expenseByCurrency };
  }

  async aggregateExpenseCategoryBreakdown(
    fromDate: string,
    toDate: string
  ): Promise<readonly ExpenseCategoryBreakdownRow[]> {
    // One row per (category, currency). Sum the category-side amount,
    // count distinct transactions. The `c.active = 1` predicate keeps
    // inactive categories from appearing even when a historical expense
    // still references them — the breakdown is for live display, the
    // ledger fact is preserved.
    const result = await this.db
      .prepare(
        `SELECT e.category_id              AS category_id,
                c.name                     AS category_name,
                t.currency_code            AS currency_code,
                SUM(e.amount_minor)        AS total_amount_minor,
                COUNT(DISTINCT t.id)       AS transaction_count
           FROM transactions t
           JOIN ledger_entries e ON e.transaction_id = t.id
           JOIN categories c     ON c.id = e.category_id
          WHERE t.state = 'POSTED'
            AND t.transaction_type = 'EXPENSE'
            AND e.category_id IS NOT NULL
            AND c.active = 1
            AND t.occurred_on >= ?
            AND t.occurred_on <  ?
          GROUP BY e.category_id, c.name, t.currency_code
          ORDER BY t.currency_code ASC, total_amount_minor DESC, c.name ASC`
      )
      .bind(fromDate, toDate)
      .all<CategoryRollupRow>();
    return result.results.map((row) => ({
      categoryId: row.category_id,
      categoryName: row.category_name,
      currencyCode: row.currency_code,
      totalAmountMinor: Number(row.total_amount_minor),
      transactionCount: row.transaction_count,
    }));
  }

  async listActiveAccounts(): Promise<readonly AccountRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM accounts
          WHERE active = 1 AND archived = 0
          ORDER BY id ASC`
      )
      .all<AccountRow>();
    return result.results.map(rowToAccount);
  }

  async listLatestReconciliationsForAccounts(
    accountIds: readonly number[]
  ): Promise<readonly ReconciliationRecord[]> {
    if (accountIds.length === 0) return [];
    // We deliberately do NOT use a correlated subquery to pick the
    // "latest per account" here. The reports service needs every
    // reconciliation row to find the latest, but a simpler and more
    // deterministic path is: select every reconciliation in (account,
    // confirmed_at DESC, id DESC) and let the service pick the first
    // per account. For a family-scale dataset this is bounded and
    // simple to reason about; a future scale-up slice can move this
    // to a windowed query.
    const placeholders = accountIds.map(() => "?").join(",");
    const result = await this.db
      .prepare(
        `SELECT * FROM account_reconciliations
          WHERE account_id IN (${placeholders})
          ORDER BY account_id ASC, confirmed_at DESC, id DESC`
      )
      .bind(...(accountIds as never[]))
      .all<ReconciliationRow>();
    return result.results.map(rowToReconciliation);
  }

  async computeClearedBalanceMinor(accountId: number, currencyCode: string): Promise<number> {
    // Mirrors the reconciliation repository formula. Different currencies
    // are never aggregated because the WHERE clause on currency_code is
    // the load-bearing constraint.
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

  async listRecentPostedTransactions(limit: number): Promise<readonly TransactionRecord[]> {
    // Filter to POSTED only — REVERSED headers are excluded so voided
    // transactions are never returned. A reversal transaction itself is
    // a separate POSTED row and will appear in the list when inside the
    // window; the description field carries the "Reversal of #N" label
    // so the UI can distinguish it.
    const result = await this.db
      .prepare(
        `SELECT * FROM transactions
          WHERE state = 'POSTED'
          ORDER BY occurred_on DESC, id DESC
          LIMIT ?`
      )
      .bind(limit)
      .all<TransactionRow>();
    return result.results.map(rowToTransaction);
  }

  async readRoleForMember(memberId: number): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT role FROM household_members WHERE id = ?")
      .bind(memberId)
      .first<{ role: string }>();
    return row === null ? null : row.role;
  }
}
