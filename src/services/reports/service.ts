/**
 * M2C reports application service.
 *
 * Platform-neutral orchestration. Composes existing service/repository
 * ports to deliver SPEC §8 dashboard queries:
 *
 *   1. monthly income / expense / net, strictly per currency;
 *   2. expense-category breakdown with drilldown-ready identifiers;
 *   3. asset / account totals by bank and currency, including the
 *      latest reconciliation status and the unreconciled flag;
 *   4. term-deposit 30/60/90 maturity statistics (composed from the
 *      existing M1C service rather than duplicating its rules);
 *   5. recent posted transactions, respecting reversal/void semantics.
 *
 * Authorization (SPEC §2 two-user model):
 *   - Every entry point requires the requesting memberId and an explicit
 *     role. Household-wide reports are OWNER-only; a MEMBER call is
 *     rejected with MEMBER_FORBIDDEN. Cross-household and inactive
 *     members are rejected with MEMBER_NOT_FOUND / MEMBER_INACTIVE.
 *   - The role is read from the household_members table; we do NOT
 *     trust a client-submitted role string.
 *
 * Financial correctness:
 *   - Every monetary value is integer minor units; no JavaScript
 *     binary floating point. BigInt is used internally to guard the
 *     per-currency sum against Number overflow when the member has
 *     many accounts in the same currency.
 *   - Transfers are never counted as income/expense (the SQL filter
 *     `transaction_type IN ('INCOME', 'EXPENSE')` plus the category-side
 *     join structurally excludes TRANSFER rows).
 *   - Term-deposit principal is never counted as income/expense
 *     (there is no migration path for term-deposit principal to
 *     become a transaction; SPEC §7 / §4.3 keep them separate).
 *   - REVERSED transaction headers are excluded from aggregates; the
 *     reversal transaction itself is a separate POSTED row and is
 *     accounted for in its own right.
 *
 * No new infrastructure is introduced: the service depends on the
 * existing account, category, term-deposit and reconciliation ports,
 * and the new reports repository for the SQL-side aggregations.
 */

import type { AccountRepository } from "../accounts/repository.js";
import type { AccountRecord } from "../accounts/types.js";
import type { MaturityStatisticsService } from "../term-deposit/maturity-statistics-service.js";
import type { ReportsRepository } from "./repository.js";
import {
  fail,
  ok,
  type AccountTotal,
  type BankCurrencyTotal,
  type BankCurrencyTotals,
  type CurrencyAmount,
  type ExpenseCategoryBreakdown,
  type MaturityAllWindowsStats,
  type MonthlyIncomeExpenseNet,
  type RecentTransaction,
  type ReconciliationRecord,
  type ServiceErrorCode,
  type ServiceResult,
} from "./types.js";

const NUMBER_MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

const MS_PER_DAY = 86_400_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HOUSEHOLD_ROLES = new Set(["OWNER", "MEMBER"]);

export interface ReportsServiceDeps {
  readonly accountRepo: AccountRepository;
  readonly reportsRepo: ReportsRepository;
  readonly maturityStatisticsService: MaturityStatisticsService;
}

export class ReportsApplicationService {
  constructor(private readonly deps: ReportsServiceDeps) {}

  // ── Monthly income / expense / net ─────────────────────────────────────

  /**
   * Compute this-month income, expense and net for the household.
   *
   * `fromDate` / `toDate` define a half-open window [from, to) over
   * which POSTED INCOME/EXPENSE transactions are summed per currency.
   * Both values must be strict ISO-8601 calendar dates; the from
   * date must be strictly before the to date.
   */
  async getMonthlyIncomeExpenseNet(
    requestingMemberId: number,
    fromDate: string,
    toDate: string
  ): Promise<ServiceResult<MonthlyIncomeExpenseNet>> {
    const auth = await this.requireOwnerMember(requestingMemberId);
    if (!auth.ok) return auth;
    const range = validateRange(fromDate, toDate);
    if (!range.ok) return range;

    const { incomeByCurrency, expenseByCurrency } = await this.deps.reportsRepo.aggregateMonthlyIncomeExpense(
      fromDate,
      toDate
    );
    const netByCurrency = computePerCurrencyNet(incomeByCurrency, expenseByCurrency);
    return ok({ fromDate, toDate, incomeByCurrency, expenseByCurrency, netByCurrency });
  }

  // ── Expense category breakdown ─────────────────────────────────────────

  async getExpenseCategoryBreakdown(
    requestingMemberId: number,
    fromDate: string,
    toDate: string
  ): Promise<ServiceResult<ExpenseCategoryBreakdown>> {
    const auth = await this.requireOwnerMember(requestingMemberId);
    if (!auth.ok) return auth;
    const range = validateRange(fromDate, toDate);
    if (!range.ok) return range;

    const rows = await this.deps.reportsRepo.aggregateExpenseCategoryBreakdown(fromDate, toDate);
    return ok({ fromDate, toDate, rows });
  }

  // ── Bank / account totals with reconciliation status ──────────────────

  /**
   * Bank-and-currency rollup across the household. Every active,
   * non-archived account appears once under its bank and currency.
   * `unreconciled` is true when the account has no reconciliation
   * record OR its current cleared ledger balance no longer matches
   * the bank-confirmed balance from its most-recent reconciliation
   * (SPEC §7 / §8: a non-zero difference is displayed and never
   * silently repaired). The comparison is performed against the live
   * cleared balance rather than the historical `differenceMinor`
   * snapshot so a POSTED transaction after reconciliation correctly
   * flips the account back to unreconciled.
   */
  async getBankCurrencyTotals(requestingMemberId: number): Promise<ServiceResult<BankCurrencyTotals>> {
    const auth = await this.requireOwnerMember(requestingMemberId);
    if (!auth.ok) return auth;

    const accounts = await this.deps.reportsRepo.listActiveAccounts();
    if (accounts.length === 0) {
      return ok({ byBankAndCurrency: [] });
    }

    const accountIds = accounts.map((a) => a.id);
    const reconciliations = await this.deps.reportsRepo.listLatestReconciliationsForAccounts(accountIds);
    const latestByAccount = pickLatestPerAccount(reconciliations);

    // Compute the cleared balance once per (account, currency). The
    // SQL filter on currency_code means different currencies are never
    // aggregated inside the SUM. BigInt guards the per-currency sum
    // against overflow at the application boundary.
    const totals: AccountTotal[] = [];
    for (const account of accounts) {
      const cleared = await this.deps.reportsRepo.computeClearedBalanceMinor(
        account.id,
        account.currencyCode
      );
      const latest = latestByAccount.get(account.id) ?? null;
      // A reconciled account is one whose current cleared ledger
      // balance equals the bank-confirmed balance recorded at the
      // latest reconciliation. Any POSTED transaction after that
      // reconciliation moves `cleared` and therefore flips
      // `unreconciled` back to true. Using the historical
      // `differenceMinor` would freeze the flag at reconciliation
      // time and silently mask new activity.
      const unreconciled = latest === null || cleared !== latest.bankConfirmedBalanceMinor;
      totals.push({ account, clearedBalanceMinor: cleared, latestReconciliation: latest, unreconciled });
    }

    // Group by (bankId, currencyCode). INTERNAL accounts have bankId = null
    // and live in their own group; CASH / E_WALLET accounts with no bank
    // also share that null bucket.
    const groupKey = (a: AccountRecord): string => `${a.bankId ?? "__null__"}|${a.currencyCode}`;
    const groups = new Map<string, { bankId: number | null; currencyCode: string; items: AccountTotal[] }>();
    for (const t of totals) {
      const k = groupKey(t.account);
      const existing = groups.get(k);
      if (existing !== undefined) {
        existing.items.push(t);
      } else {
        groups.set(k, { bankId: t.account.bankId, currencyCode: t.account.currencyCode, items: [t] });
      }
    }

    const byBankAndCurrency: BankCurrencyTotal[] = [];
    for (const g of groups.values()) {
      // Bigint per-currency total. The account count is a small safe
      // integer; the balance is the only field that can overflow.
      let total = 0n;
      for (const item of g.items) {
        total += BigInt(item.clearedBalanceMinor);
      }
      if (total < -NUMBER_MAX_SAFE_INTEGER || total > NUMBER_MAX_SAFE_INTEGER) {
        return fail(
          "OVERFLOW",
          `bank ${g.bankId ?? "null"} / currency ${g.currencyCode} total exceeds Number.MAX_SAFE_INTEGER`
        );
      }
      byBankAndCurrency.push({
        bankId: g.bankId,
        currencyCode: g.currencyCode,
        accountCount: g.items.length,
        totalBalanceMinor: Number(total),
        accounts: g.items,
      });
    }
    // Stable order: bankId nulls last, then ASC, then currency ASC.
    byBankAndCurrency.sort((a, b) => {
      if (a.bankId === null && b.bankId !== null) return 1;
      if (a.bankId !== null && b.bankId === null) return -1;
      if (a.bankId !== null && b.bankId !== null && a.bankId !== b.bankId) {
        return a.bankId < b.bankId ? -1 : 1;
      }
      return a.currencyCode < b.currencyCode ? -1 : a.currencyCode > b.currencyCode ? 1 : 0;
    });

    return ok({ byBankAndCurrency });
  }

  // ── Term-deposit 30/60/90 maturity statistics (composed) ─────────────

  /**
   * Compose the existing M1C maturity statistics service rather than
   * duplicating its 30/60/90 rules. The composed output is returned
   * unchanged so callers can rely on the same shape the M1C slice
   * already publishes (SPEC §8 maturity calendar/timeline).
   *
   * `today` is a strict ISO 'YYYY-MM-DD' calendar date in UTC; the
   * existing service rejects malformed values with INVALID_INPUT.
   */
  async getMaturityStatistics(
    requestingMemberId: number,
    today: string
  ): Promise<ServiceResult<MaturityAllWindowsStats>> {
    const auth = await this.requireOwnerMember(requestingMemberId);
    if (!auth.ok) return auth;
    const result = await this.deps.maturityStatisticsService.computeAllWindows(today);
    if (result.ok) return ok(result.value);
    // Maturity statistics can only fail with INVALID_INPUT or OVERFLOW,
    // both of which are valid reports ServiceErrorCode members.
    return fail(result.error.code as ServiceErrorCode, result.error.message);
  }

  // ── Recent posted transactions ────────────────────────────────────────

  /**
   * List the most-recently occurred POSTED transactions across the
   * household. REVERSED headers are excluded; the reversal transaction
   * itself is a separate POSTED row. `limit` defaults to 20 and is
   * capped at 100 so a single dashboard request cannot pull the entire
   * ledger.
   */
  async getRecentTransactions(
    requestingMemberId: number,
    limit?: number
  ): Promise<ServiceResult<readonly RecentTransaction[]>> {
    const auth = await this.requireOwnerMember(requestingMemberId);
    if (!auth.ok) return auth;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      return fail("INVALID_INPUT", "limit must be a positive safe integer when provided");
    }
    const effectiveLimit = clampRecentLimit(limit);
    const txs = await this.deps.reportsRepo.listRecentPostedTransactions(effectiveLimit);
    const out: RecentTransaction[] = txs.map((t) => ({ transaction: t }));
    return ok(out);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async requireOwnerMember(memberId: number): Promise<ServiceResult<true>> {
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    // SPEC §2: authorization is determined by the allowlisted role stored
    // in the household_members table. The reports repository's
    // `readRoleForMember` is a narrow, single-purpose read used only
    // for OWNER-only authorization. The public account repository
    // member context intentionally does not expose the role — that is
    // an authorization concern, not a business state concern.
    const role = await this.deps.reportsRepo.readRoleForMember(memberId);
    if (role === null) {
      return fail("MEMBER_NOT_FOUND", `household member ${memberId} not found`);
    }
    const ctx = await this.deps.accountRepo.loadMemberContext(memberId);
    if (ctx === null) {
      return fail("MEMBER_NOT_FOUND", `household member ${memberId} not found`);
    }
    if (ctx.active !== 1) {
      return fail("MEMBER_INACTIVE", `household member ${memberId} is inactive`);
    }
    if (!HOUSEHOLD_ROLES.has(role)) {
      return fail("MEMBER_FORBIDDEN", `household member ${memberId} has an unknown role`);
    }
    if (role !== "OWNER") {
      return fail("MEMBER_FORBIDDEN", `household reports require OWNER; member ${memberId} is ${role}`);
    }
    return ok(true);
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

function validateRange(fromDate: string, toDate: string): ServiceResult<true> {
  if (typeof fromDate !== "string" || !ISO_DATE_PATTERN.test(fromDate)) {
    return fail("INVALID_INPUT", "fromDate must be ISO YYYY-MM-DD");
  }
  if (typeof toDate !== "string" || !ISO_DATE_PATTERN.test(toDate)) {
    return fail("INVALID_INPUT", "toDate must be ISO YYYY-MM-DD");
  }
  if (!isRealCalendarDate(fromDate) || !isRealCalendarDate(toDate)) {
    return fail("INVALID_INPUT", "fromDate / toDate must be real calendar dates");
  }
  if (!(fromDate < toDate)) {
    return fail("INVALID_INPUT", "fromDate must be strictly before toDate");
  }
  // Reject windows longer than 12 months so a dashboard misconfiguration
  // cannot pull the entire ledger.
  const fromMs = Date.UTC(
    Number(fromDate.slice(0, 4)),
    Number(fromDate.slice(5, 7)) - 1,
    Number(fromDate.slice(8, 10))
  );
  const toMs = Date.UTC(
    Number(toDate.slice(0, 4)),
    Number(toDate.slice(5, 7)) - 1,
    Number(toDate.slice(8, 10))
  );
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return fail("INVALID_INPUT", "fromDate / toDate must be real calendar dates");
  }
  const days = (toMs - fromMs) / MS_PER_DAY;
  if (days > 366) {
    return fail("INVALID_INPUT", "date range must be at most 366 days");
  }
  return ok(true);
}

function isRealCalendarDate(s: string): boolean {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

/**
 * Per-currency net (income − expense). Both input lists are
 * currency-bucketed; the net is computed strictly per currency so
 * different currencies are never subtracted across each other.
 */
function computePerCurrencyNet(
  income: readonly CurrencyAmount[],
  expense: readonly CurrencyAmount[]
): readonly CurrencyAmount[] {
  const byCurrency = new Map<string, { inc: number; exp: number }>();
  for (const i of income) {
    const e = byCurrency.get(i.currencyCode) ?? { inc: 0, exp: 0 };
    e.inc = i.amountMinor;
    byCurrency.set(i.currencyCode, e);
  }
  for (const e of expense) {
    const v = byCurrency.get(e.currencyCode) ?? { inc: 0, exp: 0 };
    v.exp = e.amountMinor;
    byCurrency.set(e.currencyCode, v);
  }
  const out: CurrencyAmount[] = [];
  for (const [currencyCode, v] of byCurrency.entries()) {
    const net = v.inc - v.exp;
    if (!Number.isSafeInteger(net)) {
      // We mirror the SafeNumberRange guard from the maturity
      // statistics service so a misconfigured dataset cannot corrupt
      // the dashboard with an out-of-range number.
      throw new Error(`computePerCurrencyNet: net for ${currencyCode} is outside the safe-integer range`);
    }
    out.push({ currencyCode, amountMinor: net });
  }
  out.sort((a, b) => (a.currencyCode < b.currencyCode ? -1 : a.currencyCode > b.currencyCode ? 1 : 0));
  return out;
}

function pickLatestPerAccount(
  reconciliations: readonly ReconciliationRecord[]
): Map<number, ReconciliationRecord> {
  // The repository returns rows ordered (account_id ASC, confirmed_at
  // DESC, id DESC), so the first row for each account id is the
  // latest. A simple Map keyed on accountId captures that.
  const latest = new Map<number, ReconciliationRecord>();
  for (const r of reconciliations) {
    if (!latest.has(r.accountId)) {
      latest.set(r.accountId, r);
    }
  }
  return latest;
}

function clampRecentLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (limit > 100) return 100;
  return limit;
}
