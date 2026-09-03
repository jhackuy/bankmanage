/**
 * Reports repository interface.
 *
 * Application service depends on this abstract port. The D1 adapter in
 * `./d1-repository.ts` provides the production implementation; tests use
 * the same port against the FakeD1Database binding.
 *
 * The repository is responsible for:
 *   - row-to-domain mapping (no JS floating point on money);
 *   - parameterized SQL only;
 *   - executing aggregation queries for the read-side dashboard.
 *
 * The repository does NOT:
 *   - validate business invariants (those live in the application service);
 *   - enforce OWNER authorization (the service does that);
 *   - compose term-deposit maturity statistics (that lives in the
 *     term-deposit service and is called from the reports service).
 */

import type { AccountRecord } from "../accounts/types.js";
import type { ReconciliationRecord } from "../reconciliation/types.js";
import type { TransactionRecord } from "../transactions/types.js";
import type { AccountTotal, CurrencyAmount, ExpenseCategoryBreakdownRow } from "./types.js";

export interface ReportsRepository {
  /**
   * Aggregate POSTED INCOME/EXPENSE amounts for the half-open month
   * `[fromDate, toDate)`, grouped strictly by currency. TRANSFER rows
   * are excluded because they have no category-side entry; REVERSED
   * transactions are excluded at the SQL level.
   *
   * Returns a tuple of:
   *   - income rows (currency_code ASC, total ASC, count ASC),
   *   - expense rows,
   *   - the sum of per-currency transaction counts included in the window.
   */
  aggregateMonthlyIncomeExpense(
    fromDate: string,
    toDate: string
  ): Promise<{
    readonly incomeByCurrency: readonly CurrencyAmount[];
    readonly expenseByCurrency: readonly CurrencyAmount[];
  }>;

  /**
   * Aggregate POSTED EXPENSE amounts per category, per currency, in
   * the half-open window `[fromDate, toDate)`. Returns drilldown-ready
   * rows that include the categoryId, categoryName, currency, total
   * amount and transaction count.
   */
  aggregateExpenseCategoryBreakdown(
    fromDate: string,
    toDate: string
  ): Promise<readonly ExpenseCategoryBreakdownRow[]>;

  /**
   * SELECT every active, non-archived account. Returned in id ASC so
   * the service can derive a stable bank/currency rollup.
   */
  listActiveAccounts(): Promise<readonly AccountRecord[]>;

  /**
   * SELECT every reconciliation record for the given account ids.
   * Returned in (account_id ASC, confirmed_at DESC, id DESC) so the
   * service can pick the latest for each account without a second
   * round-trip.
   */
  listLatestReconciliationsForAccounts(
    accountIds: readonly number[]
  ): Promise<readonly ReconciliationRecord[]>;

  /**
   * Compute the cleared ledger balance for an account in its
   * currency, in integer minor units. Same formula as the
   * reconciliation repository; mirrored here so the reports service
   * doesn't have to depend on the reconciliation repository.
   */
  computeClearedBalanceMinor(accountId: number, currencyCode: string): Promise<number>;

  /**
   * SELECT the most-recent POSTED transactions across all members,
   * ordered by (occurred_on DESC, id DESC). A `limit` caps the result
   * set. The query filters out REVERSED headers so voided transactions
   * are never returned as "recent" — the reversal transaction itself
   * is a separate POSTED row and is subject to the same ordering.
   */
  listRecentPostedTransactions(limit: number): Promise<readonly TransactionRecord[]>;

  /**
   * Read the household_members.role for a member. Returns null when no
   * such member exists. This is a deliberately narrow read exposed to
   * support the SPEC §2 OWNER-only authorization rule for household-wide
   * reports; the role column is the source of truth, never a
   * client-submitted value.
   */
  readRoleForMember(memberId: number): Promise<string | null>;
}

// Re-export the composed AccountTotal shape for downstream use.
export type { AccountTotal };
