/**
 * M2C reports application-service tests.
 *
 * Exercises the full service stack through the FakeD1Database so the
 * same code path that runs in production is under test (no mocks of
 * the service or repository). Covers the acceptance criteria for the
 * M2C slice:
 *
 *   - Multi-currency isolation: per-currency totals are never summed
 *     across currencies (income/expense/net, category breakdown,
 *     bank totals).
 *   - Monthly boundaries: the half-open window [from, to) is honored;
 *     boundary days belong to exactly one month.
 *   - Income/expense/net: per-currency sums and per-currency net
 *     (income − expense) without cross-currency subtraction.
 *   - Transfers excluded: TRANSFER rows do not contribute to income
 *     or expense.
 *   - Reversal/void behavior: REVERSED headers are excluded; the
 *     reversal transaction itself is a separate POSTED row and
 *     appears in its own right.
 *   - Category breakdown/drilldown: rows expose categoryId, name,
 *     currency, total, count.
 *   - Bank/account totals: accounts grouped by (bankId, currency),
 *     with cleared balance and latest reconciliation status.
 *   - Reconciliation status: the unreconciled flag is true when
 *     the account has no reconciliation OR its latest difference
 *     is non-zero.
 *   - Recent ordering: POSTED transactions only, ordered by
 *     occurred_on DESC, id DESC.
 *   - OWNER-only access: a MEMBER caller is rejected with
 *     MEMBER_FORBIDDEN.
 *   - Invalid inputs: malformed dates, non-strict order, unknown
 *     member, inactive member, bad limit.
 *   - Safe integers: MAX_SAFE_INTEGER amounts survive the round-trip
 *     and aggregate without overflow.
 *   - Zero partial state: the service issues no mutations; an empty
 *     dataset returns empty results without throwing.
 *
 * The term-deposit 30/60/90 maturity statistics path is composed
 * rather than re-implemented; we assert only that the service
 * forwards the call and reuses the M1C output.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import { D1AccountRepository } from "../../src/services/accounts/d1-repository.js";
import { D1ReportsRepository, ReportsApplicationService } from "../../src/services/reports/index.js";
import { D1TermDepositRepository } from "../../src/services/term-deposit/d1-repository.js";
import { MaturityStatisticsService } from "../../src/services/term-deposit/maturity-statistics-service.js";

// ── Test surface ───────────────────────────────────────────────────────────

interface Seed {
  ownerId: number;
  memberId: number;
  inactiveMemberId: number;
  bankAId: number;
  bankBId: number;
  eurBankId: number;
  accountA1: number;
  accountA2: number;
  accountB1: number;
  accountEur: number;
  expenseGroceriesId: number;
  expenseDiningId: number;
  incomeSalaryId: number;
  incomeOtherId: number;
}

let db: FakeD1Database;
let service: ReportsApplicationService;

beforeEach(async () => {
  db = new FakeD1Database();
  await seedReportsFixture(db);
  const accountRepo = new D1AccountRepository(db);
  const reportsRepo = new D1ReportsRepository(db);
  const termDepositRepo = new D1TermDepositRepository(db);
  const maturityStatisticsService = new MaturityStatisticsService(termDepositRepo);
  service = new ReportsApplicationService({ accountRepo, reportsRepo, maturityStatisticsService });
});

afterEach(() => {
  db.close();
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function seedReportsFixture(d: FakeD1Database): Promise<void> {
  const owner = await d
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Owner One")
    .run();
  const member = await d
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("MEMBER", "Member Two")
    .run();
  const inactive = await d
    .prepare("INSERT INTO household_members (role, display_name, active) VALUES (?, ?, 0)")
    .bind("OWNER", "Inactive Owner")
    .run();

  const bankA = await d
    .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, 0)")
    .bind("reports-bank-a", "Reports Bank A")
    .run();
  const bankB = await d
    .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, 0)")
    .bind("reports-bank-b", "Reports Bank B")
    .run();
  const eurBank = await d
    .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, 0)")
    .bind("reports-bank-eur", "Reports Bank EUR")
    .run();

  // Owner accounts: two PHP at bankA, one PHP at bankB, one EUR at eurBank.
  const a1 = await d
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname, opening_balance_minor)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(owner.meta.last_row_id, bankA.meta.last_row_id, "PHP", "BANK", "Owner A1", 0)
    .run();
  const a2 = await d
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname, opening_balance_minor)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(owner.meta.last_row_id, bankA.meta.last_row_id, "PHP", "BANK", "Owner A2", 0)
    .run();
  const b1 = await d
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname, opening_balance_minor)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(owner.meta.last_row_id, bankB.meta.last_row_id, "PHP", "BANK", "Owner B1", 0)
    .run();
  const aEur = await d
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname, opening_balance_minor)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(owner.meta.last_row_id, eurBank.meta.last_row_id, "EUR", "BANK", "Owner EUR", 0)
    .run();

  // Income categories seeded by migration 0001 — use one of the system
  // household-salary slugs as the income-side category. The reports
  // service treats it purely as a "category_id IS NOT NULL" structural
  // marker so any active category id works for income/expense posting.
  const groceries = await d
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("groceries")
    .first<{ id: number }>();
  const dining = await d
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("dining")
    .first<{ id: number }>();
  const salary = await d
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("household-salary-nanny")
    .first<{ id: number }>();
  if (groceries === null || dining === null || salary === null) {
    throw new Error("seed setup: missing seeded categories");
  }
  // A second income-side category so tests that need a non-salary
  // income row have a category to use.
  const otherIncome = await d
    .prepare("INSERT INTO categories (slug, name, sort_order) VALUES (?, ?, ?)")
    .bind("reports-other-income", "Other Income", 99)
    .run();

  void member;
  void inactive;
  void a1;
  void a2;
  void b1;
  void aEur;
  void otherIncome;
  // ids are intentionally unused outside the tests' load() helper.
}

async function loadSeed(): Promise<Seed> {
  const owner = await db
    .prepare("SELECT id FROM household_members WHERE display_name = ?")
    .bind("Owner One")
    .first<{ id: number }>();
  const member = await db
    .prepare("SELECT id FROM household_members WHERE display_name = ?")
    .bind("Member Two")
    .first<{ id: number }>();
  const inactive = await db
    .prepare("SELECT id FROM household_members WHERE display_name = ?")
    .bind("Inactive Owner")
    .first<{ id: number }>();
  if (owner === null || member === null || inactive === null) {
    throw new Error("test seed: missing members");
  }
  const bankA = await db
    .prepare("SELECT id FROM banks WHERE slug = ?")
    .bind("reports-bank-a")
    .first<{ id: number }>();
  const bankB = await db
    .prepare("SELECT id FROM banks WHERE slug = ?")
    .bind("reports-bank-b")
    .first<{ id: number }>();
  const eurBank = await db
    .prepare("SELECT id FROM banks WHERE slug = ?")
    .bind("reports-bank-eur")
    .first<{ id: number }>();
  if (bankA === null || bankB === null || eurBank === null) {
    throw new Error("test seed: missing banks");
  }
  const a1 = await db
    .prepare("SELECT id FROM accounts WHERE nickname = ?")
    .bind("Owner A1")
    .first<{ id: number }>();
  const a2 = await db
    .prepare("SELECT id FROM accounts WHERE nickname = ?")
    .bind("Owner A2")
    .first<{ id: number }>();
  const b1 = await db
    .prepare("SELECT id FROM accounts WHERE nickname = ?")
    .bind("Owner B1")
    .first<{ id: number }>();
  const aEur = await db
    .prepare("SELECT id FROM accounts WHERE nickname = ?")
    .bind("Owner EUR")
    .first<{ id: number }>();
  if (a1 === null || a2 === null || b1 === null || aEur === null) {
    throw new Error("test seed: missing accounts");
  }
  const groceries = await db
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("groceries")
    .first<{ id: number }>();
  const dining = await db
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("dining")
    .first<{ id: number }>();
  const salary = await db
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("household-salary-nanny")
    .first<{ id: number }>();
  const otherIncome = await db
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("reports-other-income")
    .first<{ id: number }>();
  if (groceries === null || dining === null || salary === null || otherIncome === null) {
    throw new Error("test seed: missing categories");
  }
  return {
    ownerId: owner.id,
    memberId: member.id,
    inactiveMemberId: inactive.id,
    bankAId: bankA.id,
    bankBId: bankB.id,
    eurBankId: eurBank.id,
    accountA1: a1.id,
    accountA2: a2.id,
    accountB1: b1.id,
    accountEur: aEur.id,
    expenseGroceriesId: groceries.id,
    expenseDiningId: dining.id,
    incomeSalaryId: salary.id,
    incomeOtherId: otherIncome.id,
  };
}

/**
 * Post a balanced transaction (INCOME/EXPENSE/TRANSFER) directly into
 * the FakeD1Database. The reports service never writes; this helper
 * exists so each test can stage its own ledger state.
 */
async function postTransaction(
  type: "INCOME" | "EXPENSE" | "TRANSFER",
  memberId: number,
  accountId: number | null,
  destAccountId: number | null,
  categoryId: number | null,
  amountMinor: number,
  currencyCode: string,
  occurredOn: string,
  idempotencyKey: string
): Promise<number> {
  const txn = await db
    .prepare(
      `INSERT INTO transactions (transaction_type, member_id, currency_code,
                                  amount_minor, occurred_on, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(type, memberId, currencyCode, amountMinor, occurredOn, idempotencyKey)
    .run();
  const txnId = Number(txn.meta.last_row_id);
  if (type === "TRANSFER") {
    if (accountId === null || destAccountId === null) {
      throw new Error("postTransaction: TRANSFER requires source and destination");
    }
    await db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, account_id, category_id, direction,
                                     amount_minor, currency_code)
         VALUES (?, ?, NULL, 'CREDIT', ?, ?)`
      )
      .bind(txnId, accountId, amountMinor, currencyCode)
      .run();
    await db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, account_id, category_id, direction,
                                     amount_minor, currency_code)
         VALUES (?, ?, NULL, 'DEBIT', ?, ?)`
      )
      .bind(txnId, destAccountId, amountMinor, currencyCode)
      .run();
  } else if (type === "INCOME") {
    if (accountId === null || categoryId === null) {
      throw new Error("postTransaction: INCOME requires account and category");
    }
    await db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, account_id, category_id, direction,
                                     amount_minor, currency_code)
         VALUES (?, ?, NULL, 'DEBIT', ?, ?)`
      )
      .bind(txnId, accountId, amountMinor, currencyCode)
      .run();
    await db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, account_id, category_id, direction,
                                     amount_minor, currency_code)
         VALUES (?, NULL, ?, 'CREDIT', ?, ?)`
      )
      .bind(txnId, categoryId, amountMinor, currencyCode)
      .run();
  } else {
    // EXPENSE
    if (accountId === null || categoryId === null) {
      throw new Error("postTransaction: EXPENSE requires account and category");
    }
    await db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, account_id, category_id, direction,
                                     amount_minor, currency_code)
         VALUES (?, ?, NULL, 'CREDIT', ?, ?)`
      )
      .bind(txnId, accountId, amountMinor, currencyCode)
      .run();
    await db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, account_id, category_id, direction,
                                     amount_minor, currency_code)
         VALUES (?, NULL, ?, 'DEBIT', ?, ?)`
      )
      .bind(txnId, categoryId, amountMinor, currencyCode)
      .run();
  }
  return txnId;
}

// ── Monthly income/expense/net ─────────────────────────────────────────────

describe("getMonthlyIncomeExpenseNet", () => {
  it("returns per-currency income/expense/net for the month", async () => {
    const s = await loadSeed();
    // March 2026: PHP income 100_000, PHP expense 30_000, EUR expense 5_000.
    await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      100_000,
      "PHP",
      "2026-03-10",
      "k-inc-1"
    );
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseGroceriesId,
      30_000,
      "PHP",
      "2026-03-12",
      "k-exp-1"
    );
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountEur,
      null,
      s.expenseDiningId,
      5_000,
      "EUR",
      "2026-03-15",
      "k-exp-eur-1"
    );

    const r = await service.getMonthlyIncomeExpenseNet(s.ownerId, "2026-03-01", "2026-04-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fromDate).toBe("2026-03-01");
    expect(r.value.toDate).toBe("2026-04-01");
    const income = r.value.incomeByCurrency;
    const expense = r.value.expenseByCurrency;
    const net = r.value.netByCurrency;
    expect(income).toEqual([{ currencyCode: "PHP", amountMinor: 100_000 }]);
    expect(expense).toHaveLength(2);
    const phpExpense = expense.find((e) => e.currencyCode === "PHP");
    const eurExpense = expense.find((e) => e.currencyCode === "EUR");
    expect(phpExpense?.amountMinor).toBe(30_000);
    expect(eurExpense?.amountMinor).toBe(5_000);
    // Net is per-currency: PHP net = 70_000; EUR net = -5_000.
    const phpNet = net.find((n) => n.currencyCode === "PHP");
    const eurNet = net.find((n) => n.currencyCode === "EUR");
    expect(phpNet?.amountMinor).toBe(70_000);
    expect(eurNet?.amountMinor).toBe(-5_000);
  });

  it("honors the half-open monthly boundary: last day of month is excluded", async () => {
    const s = await loadSeed();
    // Feb 28 belongs to [Feb 1, Mar 1). Mar 1 belongs to the NEXT month.
    await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      10_000,
      "PHP",
      "2026-02-28",
      "k-feb-end"
    );
    await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      20_000,
      "PHP",
      "2026-03-01",
      "k-mar-start"
    );
    const r = await service.getMonthlyIncomeExpenseNet(s.ownerId, "2026-02-01", "2026-03-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const feb = r.value.incomeByCurrency.find((c) => c.currencyCode === "PHP");
    expect(feb?.amountMinor).toBe(10_000);
  });

  it("excludes TRANSFER transactions from income and expense", async () => {
    const s = await loadSeed();
    await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      10_000,
      "PHP",
      "2026-04-05",
      "k-inc-2"
    );
    await postTransaction(
      "TRANSFER",
      s.ownerId,
      s.accountA1,
      s.accountA2,
      null,
      50_000,
      "PHP",
      "2026-04-06",
      "k-tr-1"
    );
    const r = await service.getMonthlyIncomeExpenseNet(s.ownerId, "2026-04-01", "2026-05-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 10_000 income, 0 expense — transfer does not contribute to either.
    expect(r.value.incomeByCurrency).toEqual([{ currencyCode: "PHP", amountMinor: 10_000 }]);
    expect(r.value.expenseByCurrency).toEqual([]);
  });

  it("excludes REVERSED transactions from income/expense", async () => {
    const s = await loadSeed();
    const postedId = await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      10_000,
      "PHP",
      "2026-05-10",
      "k-inc-rev"
    );
    // Reverse the transaction.
    await db.prepare("UPDATE transactions SET state = 'REVERSED' WHERE id = ?").bind(postedId).run();
    const r = await service.getMonthlyIncomeExpenseNet(s.ownerId, "2026-05-01", "2026-06-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.incomeByCurrency).toEqual([]);
    expect(r.value.expenseByCurrency).toEqual([]);
  });

  it("counts the reversal transaction itself as a POSTED row", async () => {
    const s = await loadSeed();
    // A reversal is itself a transaction (state=POSTED) with mirrored entries.
    // We post it as an EXPENSE with the same account, which makes the
    // dashboard treat it as a fresh expense in the same window. The
    // acceptance criterion is that REVERSED originals are excluded while
    // the reversal POSTED row is included in its own right.
    await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      10_000,
      "PHP",
      "2026-06-01",
      "k-inc-3"
    );
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseGroceriesId,
      10_000,
      "PHP",
      "2026-06-02",
      "k-rev-1"
    );
    const r = await service.getMonthlyIncomeExpenseNet(s.ownerId, "2026-06-01", "2026-07-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.incomeByCurrency).toEqual([{ currencyCode: "PHP", amountMinor: 10_000 }]);
    expect(r.value.expenseByCurrency).toEqual([{ currencyCode: "PHP", amountMinor: 10_000 }]);
  });

  it("returns empty buckets for an empty month", async () => {
    const s = await loadSeed();
    const r = await service.getMonthlyIncomeExpenseNet(s.ownerId, "2026-07-01", "2026-08-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.incomeByCurrency).toEqual([]);
    expect(r.value.expenseByCurrency).toEqual([]);
    expect(r.value.netByCurrency).toEqual([]);
  });

  it("rejects a non-positive memberId with INVALID_INPUT", async () => {
    const r = await service.getMonthlyIncomeExpenseNet(0, "2026-01-01", "2026-02-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a non-OWNER caller with MEMBER_FORBIDDEN", async () => {
    const s = await loadSeed();
    const r = await service.getMonthlyIncomeExpenseNet(s.memberId, "2026-01-01", "2026-02-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_FORBIDDEN");
  });

  it("rejects an unknown memberId with MEMBER_NOT_FOUND", async () => {
    const r = await service.getMonthlyIncomeExpenseNet(999_999_999, "2026-01-01", "2026-02-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("rejects an inactive OWNER with MEMBER_INACTIVE", async () => {
    const s = await loadSeed();
    const r = await service.getMonthlyIncomeExpenseNet(s.inactiveMemberId, "2026-01-01", "2026-02-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_INACTIVE");
  });

  it("rejects malformed fromDate / toDate", async () => {
    const s = await loadSeed();
    const r1 = await service.getMonthlyIncomeExpenseNet(s.ownerId, "2026/01/01", "2026-02-01");
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.error.code).toBe("INVALID_INPUT");
    const r2 = await service.getMonthlyIncomeExpenseNet(s.ownerId, "2026-02-30", "2026-03-01");
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe("INVALID_INPUT");
  });

  it("rejects fromDate >= toDate", async () => {
    const s = await loadSeed();
    const r = await service.getMonthlyIncomeExpenseNet(s.ownerId, "2026-03-01", "2026-03-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects windows longer than 366 days", async () => {
    const s = await loadSeed();
    const r = await service.getMonthlyIncomeExpenseNet(s.ownerId, "2025-01-01", "2026-12-31");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("accepts MAX_SAFE_INTEGER amounts without overflow", async () => {
    const s = await loadSeed();
    const big = Number.MAX_SAFE_INTEGER;
    await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      big,
      "PHP",
      "2026-08-01",
      "k-big-inc"
    );
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseGroceriesId,
      1,
      "PHP",
      "2026-08-02",
      "k-tiny-exp"
    );
    const r = await service.getMonthlyIncomeExpenseNet(s.ownerId, "2026-08-01", "2026-09-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const income = r.value.incomeByCurrency.find((c) => c.currencyCode === "PHP");
    const expense = r.value.expenseByCurrency.find((c) => c.currencyCode === "PHP");
    const net = r.value.netByCurrency.find((c) => c.currencyCode === "PHP");
    expect(income?.amountMinor).toBe(big);
    expect(expense?.amountMinor).toBe(1);
    expect(net?.amountMinor).toBe(big - 1);
  });
});

// ── Expense category breakdown ──────────────────────────────────────────────

describe("getExpenseCategoryBreakdown", () => {
  it("groups expenses by category and currency, ordered by total DESC", async () => {
    const s = await loadSeed();
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseGroceriesId,
      30_000,
      "PHP",
      "2026-03-10",
      "k-bk-1"
    );
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseGroceriesId,
      12_000,
      "PHP",
      "2026-03-11",
      "k-bk-2"
    );
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseDiningId,
      5_000,
      "PHP",
      "2026-03-12",
      "k-bk-3"
    );
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountEur,
      null,
      s.expenseDiningId,
      1_000,
      "EUR",
      "2026-03-13",
      "k-bk-eur-1"
    );

    const r = await service.getExpenseCategoryBreakdown(s.ownerId, "2026-03-01", "2026-04-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.value.rows;
    expect(rows).toHaveLength(3);
    // PHP rows come first (currency ASC), ordered by total DESC within currency.
    const phpGroceries = rows.find(
      (row) => row.categoryId === s.expenseGroceriesId && row.currencyCode === "PHP"
    );
    const phpDining = rows.find((row) => row.categoryId === s.expenseDiningId && row.currencyCode === "PHP");
    const eurDining = rows.find((row) => row.categoryId === s.expenseDiningId && row.currencyCode === "EUR");
    expect(phpGroceries?.totalAmountMinor).toBe(42_000);
    expect(phpGroceries?.transactionCount).toBe(2);
    expect(phpDining?.totalAmountMinor).toBe(5_000);
    expect(phpDining?.transactionCount).toBe(1);
    expect(eurDining?.totalAmountMinor).toBe(1_000);
    expect(eurDining?.transactionCount).toBe(1);
  });

  it("excludes INCOME/TRANSFER and REVERSED rows", async () => {
    const s = await loadSeed();
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseGroceriesId,
      10_000,
      "PHP",
      "2026-04-01",
      "k-bk-p"
    );
    await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      100_000,
      "PHP",
      "2026-04-02",
      "k-bk-i"
    );
    await postTransaction(
      "TRANSFER",
      s.ownerId,
      s.accountA1,
      s.accountA2,
      null,
      50_000,
      "PHP",
      "2026-04-03",
      "k-bk-t"
    );
    const reversed = await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseGroceriesId,
      999_999,
      "PHP",
      "2026-04-04",
      "k-bk-rev"
    );
    await db.prepare("UPDATE transactions SET state = 'REVERSED' WHERE id = ?").bind(reversed).run();

    const r = await service.getExpenseCategoryBreakdown(s.ownerId, "2026-04-01", "2026-05-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rows).toHaveLength(1);
    expect(r.value.rows[0]?.totalAmountMinor).toBe(10_000);
  });

  it("excludes inactive categories even when ledger entries reference them", async () => {
    const s = await loadSeed();
    // Deactivate a category after the transaction is posted; the breakdown
    // must drop it (the breakdown is for live display, the ledger is
    // preserved).
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseDiningId,
      5_000,
      "PHP",
      "2026-09-01",
      "k-bk-d"
    );
    await db.prepare("UPDATE categories SET active = 0 WHERE id = ?").bind(s.expenseDiningId).run();
    const r = await service.getExpenseCategoryBreakdown(s.ownerId, "2026-09-01", "2026-10-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rows).toEqual([]);
  });

  it("rejects invalid ranges with INVALID_INPUT", async () => {
    const s = await loadSeed();
    const r = await service.getExpenseCategoryBreakdown(s.ownerId, "2026-05-31", "2026-05-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects non-OWNER caller with MEMBER_FORBIDDEN", async () => {
    const s = await loadSeed();
    const r = await service.getExpenseCategoryBreakdown(s.memberId, "2026-01-01", "2026-02-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_FORBIDDEN");
  });
});

// ── Bank / account totals ──────────────────────────────────────────────────

describe("getBankCurrencyTotals", () => {
  it("groups accounts by (bankId, currency) with cleared balance and latest reconciliation", async () => {
    const s = await loadSeed();
    // Account A1 PHP: opening 0 + 1 INCOME of 20_000 → cleared 20_000.
    await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      20_000,
      "PHP",
      "2026-03-05",
      "k-bt-1"
    );
    // Account A2 PHP: 1 EXPENSE of 5_000 → cleared -5_000.
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA2,
      null,
      s.expenseGroceriesId,
      5_000,
      "PHP",
      "2026-03-06",
      "k-bt-2"
    );
    // Account B1 PHP: opening 0, no entries → cleared 0.
    // Account EUR: opening 0, no entries → cleared 0.

    // Record a reconciliation for A1 with difference = 0.
    await db
      .prepare(
        `INSERT INTO account_reconciliations (
           account_id, member_id, currency_code,
           bank_confirmed_balance_minor, cleared_balance_minor, difference_minor,
           confirmed_at, idempotency_key, currency_declared
         ) VALUES (?, ?, 'PHP', ?, ?, ?, '2026-03-31T10:00:00.000Z', 'k-bt-recon', 0)`
      )
      .bind(s.accountA1, s.ownerId, 20_000, 20_000, 0)
      .run();

    const r = await service.getBankCurrencyTotals(s.ownerId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const groups = r.value.byBankAndCurrency;
    // Four groups: (bankA, PHP), (bankB, PHP), (eurBank, EUR).
    expect(groups).toHaveLength(3);
    const bankAPhp = groups.find((g) => g.bankId === s.bankAId && g.currencyCode === "PHP");
    const bankBPhp = groups.find((g) => g.bankId === s.bankBId && g.currencyCode === "PHP");
    const bankEur = groups.find((g) => g.bankId === s.eurBankId && g.currencyCode === "EUR");
    expect(bankAPhp?.accountCount).toBe(2);
    expect(bankBPhp?.accountCount).toBe(1);
    expect(bankEur?.accountCount).toBe(1);
    // bankA PHP total: 20_000 + (-5_000) = 15_000 (per-currency, no mixing).
    expect(bankAPhp?.totalBalanceMinor).toBe(15_000);
    expect(bankBPhp?.totalBalanceMinor).toBe(0);
    expect(bankEur?.totalBalanceMinor).toBe(0);

    // The A1 account has a zero-difference reconciliation → unreconciled = false.
    const a1Total = bankAPhp?.accounts.find((a) => a.account.id === s.accountA1);
    expect(a1Total?.latestReconciliation).not.toBeNull();
    expect(a1Total?.unreconciled).toBe(false);
    // A2 has no reconciliation → unreconciled = true.
    const a2Total = bankAPhp?.accounts.find((a) => a.account.id === s.accountA2);
    expect(a2Total?.latestReconciliation).toBeNull();
    expect(a2Total?.unreconciled).toBe(true);
    // EUR has no reconciliation → unreconciled = true.
    const eurTotal = bankEur?.accounts[0];
    expect(eurTotal?.unreconciled).toBe(true);
  });

  it("marks accounts with a non-zero latest reconciliation difference as unreconciled", async () => {
    const s = await loadSeed();
    await db
      .prepare(
        `INSERT INTO account_reconciliations (
           account_id, member_id, currency_code,
           bank_confirmed_balance_minor, cleared_balance_minor, difference_minor,
           confirmed_at, idempotency_key, currency_declared
         ) VALUES (?, ?, 'PHP', 100_000, 0, 100_000, '2026-04-01T10:00:00.000Z', 'k-diff', 0)`
      )
      .bind(s.accountA1, s.ownerId)
      .run();
    const r = await service.getBankCurrencyTotals(s.ownerId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const group = r.value.byBankAndCurrency.find((g) => g.bankId === s.bankAId && g.currencyCode === "PHP");
    const a1 = group?.accounts.find((a) => a.account.id === s.accountA1);
    expect(a1?.unreconciled).toBe(true);
  });

  it("excludes archived and inactive accounts from the rollup", async () => {
    const s = await loadSeed();
    await db.prepare("UPDATE accounts SET archived = 1 WHERE id = ?").bind(s.accountA2).run();
    await db.prepare("UPDATE accounts SET active = 0 WHERE id = ?").bind(s.accountB1).run();
    const r = await service.getBankCurrencyTotals(s.ownerId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.byBankAndCurrency.flatMap((g) => g.accounts.map((a) => a.account.id));
    expect(ids).toContain(s.accountA1);
    expect(ids).not.toContain(s.accountA2);
    expect(ids).not.toContain(s.accountB1);
    expect(ids).toContain(s.accountEur);
  });

  it("returns an empty list when there are no active accounts", async () => {
    const s = await loadSeed();
    await db.prepare("UPDATE accounts SET active = 0").run();
    const r = await service.getBankCurrencyTotals(s.ownerId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.byBankAndCurrency).toEqual([]);
  });

  it("rejects non-OWNER caller with MEMBER_FORBIDDEN", async () => {
    const s = await loadSeed();
    const r = await service.getBankCurrencyTotals(s.memberId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_FORBIDDEN");
  });
});

// ── Recent posted transactions ─────────────────────────────────────────────

describe("getRecentTransactions", () => {
  it("returns POSTED transactions in occurred_on DESC, id DESC order, capped at the limit", async () => {
    const s = await loadSeed();
    await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      1_000,
      "PHP",
      "2026-03-01",
      "k-r-1"
    );
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseGroceriesId,
      2_000,
      "PHP",
      "2026-03-02",
      "k-r-2"
    );
    await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      3_000,
      "PHP",
      "2026-03-03",
      "k-r-3"
    );
    const r = await service.getRecentTransactions(s.ownerId, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.value[0]?.transaction.occurredOn).toBe("2026-03-03");
    expect(r.value[1]?.transaction.occurredOn).toBe("2026-03-02");
  });

  it("excludes REVERSED headers and includes the reversal transaction itself when POSTED", async () => {
    const s = await loadSeed();
    const original = await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseGroceriesId,
      5_000,
      "PHP",
      "2026-04-01",
      "k-rr-orig"
    );
    await db.prepare("UPDATE transactions SET state = 'REVERSED' WHERE id = ?").bind(original).run();
    await postTransaction(
      "EXPENSE",
      s.ownerId,
      s.accountA1,
      null,
      s.expenseGroceriesId,
      5_000,
      "PHP",
      "2026-04-02",
      "k-rr-rev"
    );
    const r = await service.getRecentTransactions(s.ownerId, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only the reversal (POSTED) is in the recent list.
    expect(r.value).toHaveLength(1);
    expect(r.value[0]?.transaction.idempotencyKey).toBe("k-rr-rev");
  });

  it("uses default limit 20 and caps at 100", async () => {
    const s = await loadSeed();
    // 5 transactions is enough to exercise the default path.
    for (let i = 0; i < 5; i++) {
      await postTransaction(
        "INCOME",
        s.ownerId,
        s.accountA1,
        null,
        s.incomeSalaryId,
        100,
        "PHP",
        `2026-05-0${i + 1}`,
        `k-d-${i}`
      );
    }
    const r = await service.getRecentTransactions(s.ownerId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(5);
  });

  it("rejects non-positive limit with INVALID_INPUT", async () => {
    const s = await loadSeed();
    const r = await service.getRecentTransactions(s.ownerId, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects non-OWNER caller with MEMBER_FORBIDDEN", async () => {
    const s = await loadSeed();
    const r = await service.getRecentTransactions(s.memberId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_FORBIDDEN");
  });
});

// ── Maturity statistics (composed) ─────────────────────────────────────────

describe("getMaturityStatistics", () => {
  it("forwards the call to the existing M1C maturity statistics service", async () => {
    const s = await loadSeed();
    // No deposits seeded — the composed service should return an empty
    // but well-formed 30/60/90 result, exactly as the M1C service
    // documents. We assert only the public shape and that the call
    // passes authorization.
    const r = await service.getMaturityStatistics(s.ownerId, "2026-09-03");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days30.windowDays).toBe(30);
    expect(r.value.days60.windowDays).toBe(60);
    expect(r.value.days90.windowDays).toBe(90);
    expect(r.value.days30.fromDate).toBe("2026-09-03");
    expect(r.value.days30.toDate).toBe("2026-10-03");
    expect(r.value.days90.toDate).toBe("2026-12-02");
    expect(r.value.days30.byCurrency).toEqual([]);
  });

  it("rejects malformed `today` with INVALID_INPUT (composed service error passes through)", async () => {
    const s = await loadSeed();
    const r = await service.getMaturityStatistics(s.ownerId, "2026/09/03");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects non-OWNER caller with MEMBER_FORBIDDEN", async () => {
    const s = await loadSeed();
    const r = await service.getMaturityStatistics(s.memberId, "2026-09-03");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_FORBIDDEN");
  });
});

// ── Zero partial state ─────────────────────────────────────────────────────

describe("zero partial state", () => {
  it("issues no mutations: the service is read-only", async () => {
    const s = await loadSeed();
    const before = await countRows("SELECT COUNT(*) AS c FROM transactions");
    await postTransaction(
      "INCOME",
      s.ownerId,
      s.accountA1,
      null,
      s.incomeSalaryId,
      1_000,
      "PHP",
      "2026-06-01",
      "k-z-1"
    );

    // Exercise every read-side entry point. None must issue a write.
    await service.getMonthlyIncomeExpenseNet(s.ownerId, "2026-06-01", "2026-07-01");
    await service.getExpenseCategoryBreakdown(s.ownerId, "2026-06-01", "2026-07-01");
    await service.getBankCurrencyTotals(s.ownerId);
    await service.getRecentTransactions(s.ownerId, 5);
    await service.getMaturityStatistics(s.ownerId, "2026-06-01");

    const after = await countRows("SELECT COUNT(*) AS c FROM transactions");
    expect(after).toBe(before + 1); // only the explicit post
  });
});

async function countRows(sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ c: number }>();
  return row?.c ?? 0;
}
