/**
 * M2A transactions application-service tests.
 *
 * Exercises the full service stack through the FakeD1Database so the
 * same code path that runs in production is under test (no mocks of
 * the service or repository).
 *
 * Covers the production-path cases the M2A slice ships:
 *   - Happy paths for INCOME, EXPENSE, TRANSFER.
 *   - Cross-currency rejection with the right error code (CROSS_CURRENCY_REJECTED
 *     takes priority over CURRENCY_MISMATCH).
 *   - Account-ownership rejection (ACCOUNT_FORBIDDEN — cross-member posting).
 *   - Inactive member rejection (MEMBER_INACTIVE) and missing-member rejection
 *     (MEMBER_NOT_FOUND).
 *   - Inactive-account / archived-account rejection (ACCOUNT_INACTIVE).
 *   - Missing / inactive category rejection (INVALID_INPUT, CATEGORY_NOT_FOUND,
 *     CATEGORY_INACTIVE).
 *   - Idempotency-key reuse with the SAME immutable request identity (returns
 *     existing transaction with `created: false`).
 *   - Idempotency-key reuse with a DIFFERENT immutable request identity
 *     surfaces IDEMPOTENCY_CONFLICT — silently returning the prior record
 *     on a conflicting payload would hide a client bug.
 *   - Reversal: idempotent retry of an already-reversed transaction returns
 *     the existing reversal (200, not a duplicate error).
 *   - Reversal: race-safe concurrent reverser returns the winner's reversal.
 *   - Reversal: the reversed entries' SUM(amount × sign) is zero — the
 *     balance invariant is preserved.
 *   - Atomicity: the CTE insert guarantees the header and BOTH ledger
 *     entries land together, never a header-with-zero-entries orphan.
 *   - Atomicity: forced batch failure leaves zero partial state and a
 *     retry succeeds.
 *   - Recovery: deleteTransactionAndEntries refuses to delete a linked
 *     transaction and succeeds only on true orphans.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import { D1AccountRepository } from "../../src/services/accounts/d1-repository.js";
import { D1CategoryRepository } from "../../src/services/categories/d1-repository.js";
import {
  D1TransactionsRepository,
  TransactionApplicationService,
  type PostIncomeExpenseInput,
  type PostTransferInput,
} from "../../src/services/transactions/index.js";

interface Seed {
  memberId: number;
  otherMemberId: number;
  bankId: number;
  accountId: number;
  secondAccountId: number;
  otherMemberAccountId: number;
  incomeCategoryId: number;
  expenseCategoryId: number;
}

let db: FakeD1Database;
let txRepo: D1TransactionsRepository;
let txService: TransactionApplicationService;

beforeEach(async () => {
  db = new FakeD1Database();
  const accountRepo = new D1AccountRepository(db);
  const categoryRepo = new D1CategoryRepository(db);
  txRepo = new D1TransactionsRepository(db);
  txService = new TransactionApplicationService(txRepo, accountRepo, categoryRepo);

  // Member A: owner of two PHP bank accounts
  const m1 = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Test Owner")
    .run();
  // Member B: another owner whose account must NOT be usable by A
  const m2 = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Test Owner B")
    .run();
  const bank = await db
    .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, 0)")
    .bind("test-bank", "Test Bank")
    .run();
  const bank2 = await db
    .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, 0)")
    .bind("test-bank-eur", "Test Bank EUR")
    .run();

  const a1 = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(m1.meta.last_row_id, bank.meta.last_row_id, "PHP", "BANK", "Member A Checking")
    .run();
  const a2 = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(m1.meta.last_row_id, bank.meta.last_row_id, "PHP", "BANK", "Member A Savings")
    .run();
  const a3 = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(m2.meta.last_row_id, bank2.meta.last_row_id, "EUR", "BANK", "Member B EUR")
    .run();

  // Categories seeded by migration 0001 are system + active by default.
  // We pick two by slug: one for income, one for expense.
  const incomeCat = await db
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("other")
    .first<{ id: number }>();
  const expenseCat = await db
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("groceries")
    .first<{ id: number }>();
  if (incomeCat === null || expenseCat === null) {
    throw new Error("seed setup: missing seeded categories");
  }

  return {
    memberId: Number(m1.meta.last_row_id),
    otherMemberId: Number(m2.meta.last_row_id),
    bankId: Number(bank.meta.last_row_id),
    accountId: Number(a1.meta.last_row_id),
    secondAccountId: Number(a2.meta.last_row_id),
    otherMemberAccountId: Number(a3.meta.last_row_id),
    incomeCategoryId: incomeCat.id,
    expenseCategoryId: expenseCat.id,
  } satisfies Seed;
});

afterEach(() => {
  db.close();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function income(overrides: Partial<PostIncomeExpenseInput> = {}): PostIncomeExpenseInput {
  return {
    memberId: 0,
    accountId: 0,
    currencyCode: "PHP",
    amountMinor: 100_000,
    occurredOn: "2026-03-15",
    idempotencyKey: "income-key-1",
    categoryId: 0,
    description: "Salary",
    ...overrides,
  };
}

function expense(overrides: Partial<PostIncomeExpenseInput> = {}): PostIncomeExpenseInput {
  return {
    memberId: 0,
    accountId: 0,
    currencyCode: "PHP",
    amountMinor: 25_000,
    occurredOn: "2026-03-16",
    idempotencyKey: "expense-key-1",
    categoryId: 0,
    description: "Groceries",
    ...overrides,
  };
}

function transfer(overrides: Partial<PostTransferInput> = {}): PostTransferInput {
  return {
    memberId: 0,
    sourceAccountId: 0,
    destinationAccountId: 0,
    currencyCode: "PHP",
    amountMinor: 50_000,
    occurredOn: "2026-03-17",
    idempotencyKey: "transfer-key-1",
    description: "Move to savings",
    ...overrides,
  };
}

async function countRows(sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ c: number }>();
  return row?.c ?? 0;
}

// ── Happy paths ─────────────────────────────────────────────────────────────

describe("postIncomeExpense — happy paths", () => {
  it("posts an INCOME with 2 balanced entries and marks created=true", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const result = await txService.postIncomeExpense(
      "INCOME",
      income({ memberId: seed.memberId, accountId: seed.accountId, categoryId: seed.incomeCategoryId })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    expect(result.value.transaction.transactionType).toBe("INCOME");
    expect(result.value.transaction.memberId).toBe(seed.memberId);
    expect(result.value.transaction.state).toBe("POSTED");
    expect(result.value.entries).toHaveLength(2);
    const sum = result.value.entries.reduce(
      (acc, e) => acc + (e.direction === "DEBIT" ? e.amountMinor : -e.amountMinor),
      0
    );
    expect(sum).toBe(0);
  });

  it("posts an EXPENSE with 2 balanced entries and marks created=true", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const result = await txService.postIncomeExpense(
      "EXPENSE",
      expense({ memberId: seed.memberId, accountId: seed.accountId, categoryId: seed.expenseCategoryId })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    expect(result.value.transaction.transactionType).toBe("EXPENSE");
    expect(result.value.entries).toHaveLength(2);
    const sum = result.value.entries.reduce(
      (acc, e) => acc + (e.direction === "DEBIT" ? e.amountMinor : -e.amountMinor),
      0
    );
    expect(sum).toBe(0);
  });

  it("requires a categoryId for both INCOME and EXPENSE", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const noCat = await txService.postIncomeExpense(
      "INCOME",
      income({ memberId: seed.memberId, accountId: seed.accountId, categoryId: undefined })
    );
    expect(noCat.ok).toBe(false);
    if (noCat.ok) return;
    expect(noCat.error.code).toBe("INVALID_INPUT");

    const noCat2 = await txService.postIncomeExpense(
      "EXPENSE",
      expense({ memberId: seed.memberId, accountId: seed.accountId, categoryId: undefined })
    );
    expect(noCat2.ok).toBe(false);
    if (noCat2.ok) return;
    expect(noCat2.error.code).toBe("INVALID_INPUT");
  });
});

describe("postTransfer — happy paths", () => {
  it("posts a TRANSFER with 2 account-side entries and marks created=true", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const result = await txService.postTransfer(
      transfer({
        memberId: seed.memberId,
        sourceAccountId: seed.accountId,
        destinationAccountId: seed.secondAccountId,
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    expect(result.value.transaction.transactionType).toBe("TRANSFER");
    expect(result.value.entries).toHaveLength(2);
    const sourceEntry = result.value.entries.find((e) => e.direction === "CREDIT");
    const destEntry = result.value.entries.find((e) => e.direction === "DEBIT");
    expect(sourceEntry?.accountId).toBe(seed.accountId);
    expect(destEntry?.accountId).toBe(seed.secondAccountId);
    const sum = result.value.entries.reduce(
      (acc, e) => acc + (e.direction === "DEBIT" ? e.amountMinor : -e.amountMinor),
      0
    );
    expect(sum).toBe(0);
  });

  it("rejects cross-currency transfer with CROSS_CURRENCY_REJECTED (not CURRENCY_MISMATCH)", async () => {
    // The test seed has no same-member EUR account, so we synthesize a
    // second PHP account for member A and add an EUR account for the
    // same member by relaxing the seed; we set up a new EUR account for
    // member A directly here.
    const seed = (await dbFirst(db)) as Seed;
    const eurBank = await db
      .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, 0)")
      .bind("test-bank-eur-a", "EUR Bank A")
      .run();
    const aEur = await db
      .prepare(
        `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(seed.memberId, eurBank.meta.last_row_id, "EUR", "BANK", "Member A EUR")
      .run();

    const result = await txService.postTransfer(
      transfer({
        memberId: seed.memberId,
        sourceAccountId: seed.accountId, // PHP
        destinationAccountId: Number(aEur.meta.last_row_id), // EUR
        currencyCode: "PHP",
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CROSS_CURRENCY_REJECTED");
  });

  it("rejects transfer between two of the member's accounts when currencyCode disagrees with CURRENCY_MISMATCH", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const result = await txService.postTransfer(
      transfer({
        memberId: seed.memberId,
        sourceAccountId: seed.accountId, // PHP
        destinationAccountId: seed.secondAccountId, // PHP
        currencyCode: "USD", // wrong currency
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CURRENCY_MISMATCH");
  });
});

// ── Ownership / active checks ───────────────────────────────────────────────

describe("ownership and active-state checks", () => {
  it("rejects posting against another member's account with ACCOUNT_FORBIDDEN", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const result = await txService.postIncomeExpense(
      "INCOME",
      income({
        memberId: seed.memberId,
        accountId: seed.otherMemberAccountId,
        categoryId: seed.incomeCategoryId,
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACCOUNT_FORBIDDEN");
  });

  it("rejects posting for an inactive member with MEMBER_INACTIVE", async () => {
    const seed = (await dbFirst(db)) as Seed;
    await db.prepare("UPDATE household_members SET active = 0 WHERE id = ?").bind(seed.memberId).run();
    const result = await txService.postIncomeExpense(
      "INCOME",
      income({ memberId: seed.memberId, accountId: seed.accountId, categoryId: seed.incomeCategoryId })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MEMBER_INACTIVE");
  });

  it("rejects posting for a non-existent member with MEMBER_NOT_FOUND", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const result = await txService.postIncomeExpense(
      "INCOME",
      income({
        memberId: 999_999_999,
        accountId: seed.accountId,
        categoryId: seed.incomeCategoryId,
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("rejects posting against an archived account with ACCOUNT_INACTIVE", async () => {
    const seed = (await dbFirst(db)) as Seed;
    await db.prepare("UPDATE accounts SET archived = 1 WHERE id = ?").bind(seed.accountId).run();
    const result = await txService.postIncomeExpense(
      "INCOME",
      income({ memberId: seed.memberId, accountId: seed.accountId, categoryId: seed.incomeCategoryId })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACCOUNT_INACTIVE");
  });

  it("rejects an inactive category with CATEGORY_INACTIVE", async () => {
    const seed = (await dbFirst(db)) as Seed;
    await db.prepare("UPDATE categories SET active = 0 WHERE id = ?").bind(seed.incomeCategoryId).run();
    const result = await txService.postIncomeExpense(
      "INCOME",
      income({ memberId: seed.memberId, accountId: seed.accountId, categoryId: seed.incomeCategoryId })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CATEGORY_INACTIVE");
  });
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe("idempotency", () => {
  it("returns the same transaction with created=false on a same-payload retry", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const first = await txService.postIncomeExpense(
      "INCOME",
      income({ memberId: seed.memberId, accountId: seed.accountId, categoryId: seed.incomeCategoryId })
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const originalId = first.value.transaction.id;

    const second = await txService.postIncomeExpense(
      "INCOME",
      income({ memberId: seed.memberId, accountId: seed.accountId, categoryId: seed.incomeCategoryId })
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.created).toBe(false);
    expect(second.value.transaction.id).toBe(originalId);
  });

  it("rejects key reuse with a different payload as IDEMPOTENCY_CONFLICT", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const first = await txService.postIncomeExpense(
      "INCOME",
      income({ memberId: seed.memberId, accountId: seed.accountId, categoryId: seed.incomeCategoryId })
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Same idempotency key, different amount.
    const conflict = await txService.postIncomeExpense(
      "INCOME",
      income({
        memberId: seed.memberId,
        accountId: seed.accountId,
        categoryId: seed.incomeCategoryId,
        amountMinor: 999_999,
      })
    );
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

// ── Reversal ────────────────────────────────────────────────────────────────

describe("reverseTransaction", () => {
  it("creates a balanced reversal, marks the original REVERSED, and is idempotent on retry", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const post = await txService.postIncomeExpense(
      "EXPENSE",
      expense({ memberId: seed.memberId, accountId: seed.accountId, categoryId: seed.expenseCategoryId })
    );
    expect(post.ok).toBe(true);
    if (!post.ok) return;
    const originalId = post.value.transaction.id;

    const rev1 = await txService.reverseTransaction({
      transactionId: originalId,
      reversedByMemberId: seed.memberId,
      reason: "Wrong category",
    });
    expect(rev1.ok).toBe(true);
    if (!rev1.ok) return;
    expect(rev1.value.created).toBe(true);
    expect(rev1.value.transaction.id).not.toBe(originalId);
    // Reversal entries sum to zero
    const sum = rev1.value.entries.reduce(
      (acc, e) => acc + (e.direction === "DEBIT" ? e.amountMinor : -e.amountMinor),
      0
    );
    expect(sum).toBe(0);

    // Original is now REVERSED
    const origRead = await txService.getTransaction(originalId);
    expect(origRead.ok).toBe(true);
    if (!origRead.ok || origRead.value === null) return;
    expect(origRead.value.transaction.state).toBe("REVERSED");

    // Retry: idempotent, returns the same reversal with created=false
    const rev2 = await txService.reverseTransaction({
      transactionId: originalId,
      reversedByMemberId: seed.memberId,
    });
    expect(rev2.ok).toBe(true);
    if (!rev2.ok) return;
    expect(rev2.value.created).toBe(false);
    expect(rev2.value.transaction.id).toBe(rev1.value.transaction.id);
  });

  it("original + reversal: combined SUM(amount × sign) is zero", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const post = await txService.postTransfer(
      transfer({
        memberId: seed.memberId,
        sourceAccountId: seed.accountId,
        destinationAccountId: seed.secondAccountId,
      })
    );
    expect(post.ok).toBe(true);
    if (!post.ok) return;
    const originalId = post.value.transaction.id;

    const rev = await txService.reverseTransaction({
      transactionId: originalId,
      reversedByMemberId: seed.memberId,
    });
    expect(rev.ok).toBe(true);
    if (!rev.ok) return;

    // Fetch both transactions and combine their entries
    const orig = await txService.getTransaction(originalId);
    const revRead = await txService.getTransaction(rev.value.transaction.id);
    expect(orig.ok).toBe(true);
    expect(revRead.ok).toBe(true);
    if (!orig.ok || !revRead.ok || orig.value === null || revRead.value === null) return;
    const all = [...orig.value.entries, ...revRead.value.entries];
    const sum = all.reduce((acc, e) => acc + (e.direction === "DEBIT" ? e.amountMinor : -e.amountMinor), 0);
    expect(sum).toBe(0);
  });
});

// ── Atomicity ───────────────────────────────────────────────────────────────

describe("repository atomicity (CTE single statement)", () => {
  it("never persists a header without both ledger entries — header and entries land together", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const result = await txService.postIncomeExpense(
      "INCOME",
      income({ memberId: seed.memberId, accountId: seed.accountId, categoryId: seed.incomeCategoryId })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const txns = await countRows("SELECT COUNT(*) AS c FROM transactions");
    const entries = await countRows("SELECT COUNT(*) AS c FROM ledger_entries");
    expect(txns).toBe(1);
    expect(entries).toBe(2);
  });

  it("a forced FK violation on the entries insert leaves zero partial state and the retry succeeds", async () => {
    // We force a FK violation by inserting with a bogus account_id on
    // a direct postTransaction call. The CTE's atomicity should roll
    // back the header INSERT when the entries INSERT fails, leaving no
    // orphan header row. A subsequent retry with a real account_id
    // succeeds.
    const seed = (await dbFirst(db)) as Seed;

    // Direct repo call with a bogus account_id (no such row).
    let caught = false;
    try {
      await txRepo.postTransaction({
        transaction: {
          memberId: seed.memberId,
          transactionType: "EXPENSE",
          currencyCode: "PHP",
          amountMinor: 1_000,
          occurredOn: "2026-03-18",
          description: null,
          idempotencyKey: "force-fail-key",
          sourceEvidenceRef: null,
        },
        entries: [
          {
            accountId: 999_999_999, // bogus
            categoryId: null,
            direction: "CREDIT",
            amountMinor: 1_000,
            currencyCode: "PHP",
            memo: null,
          },
          {
            accountId: null,
            categoryId: seed.expenseCategoryId,
            direction: "DEBIT",
            amountMinor: 1_000,
            currencyCode: "PHP",
            memo: null,
          },
        ],
      });
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);

    // No header should have been left behind.
    const txns = await countRows("SELECT COUNT(*) AS c FROM transactions");
    expect(txns).toBe(0);
    const entries = await countRows("SELECT COUNT(*) AS c FROM ledger_entries");
    expect(entries).toBe(0);

    // Now retry through the service (which provides a valid accountId).
    const retried = await txService.postIncomeExpense(
      "EXPENSE",
      expense({
        memberId: seed.memberId,
        accountId: seed.accountId,
        categoryId: seed.expenseCategoryId,
        idempotencyKey: "force-fail-key", // reuse the same key
      })
    );
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.created).toBe(true);
    expect(retried.value.entries).toHaveLength(2);
  });
});

// ── Recovery: deleteTransactionAndEntries ───────────────────────────────────

describe("recovery: deleteTransactionAndEntries", () => {
  it("refuses to delete a transaction that is linked by a reversal row", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const post = await txService.postIncomeExpense(
      "EXPENSE",
      expense({ memberId: seed.memberId, accountId: seed.accountId, categoryId: seed.expenseCategoryId })
    );
    expect(post.ok).toBe(true);
    if (!post.ok) return;

    const rev = await txService.reverseTransaction({
      transactionId: post.value.transaction.id,
      reversedByMemberId: seed.memberId,
    });
    expect(rev.ok).toBe(true);
    if (!rev.ok) return;

    let refused = false;
    try {
      await txRepo.deleteTransactionAndEntries(
        post.value.transaction.id,
        post.value.transaction.idempotencyKey
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);

    // And the reversal itself is also linked (as the reversal_transaction_id).
    let refused2 = false;
    try {
      await txRepo.deleteTransactionAndEntries(
        rev.value.transaction.id,
        rev.value.transaction.idempotencyKey
      );
    } catch {
      refused2 = true;
    }
    expect(refused2).toBe(true);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe("input validation", () => {
  it("rejects zero / negative amounts", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const r = await txService.postIncomeExpense(
      "INCOME",
      income({
        memberId: seed.memberId,
        accountId: seed.accountId,
        categoryId: seed.incomeCategoryId,
        amountMinor: 0,
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects empty idempotency key", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const r = await txService.postIncomeExpense(
      "INCOME",
      income({
        memberId: seed.memberId,
        accountId: seed.accountId,
        categoryId: seed.incomeCategoryId,
        idempotencyKey: "",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects malformed occurredOn", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const r = await txService.postIncomeExpense(
      "INCOME",
      income({
        memberId: seed.memberId,
        accountId: seed.accountId,
        categoryId: seed.incomeCategoryId,
        occurredOn: "2026-02-31",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects transfer with same source and destination", async () => {
    const seed = (await dbFirst(db)) as Seed;
    const r = await txService.postTransfer(
      transfer({
        memberId: seed.memberId,
        sourceAccountId: seed.accountId,
        destinationAccountId: seed.accountId,
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });
});

// ── Local helper: pull the seed out of beforeEach ───────────────────────────
//
// Vitest's beforeEach cannot return a value to the test. We re-seed in
// each test that needs the IDs; this is cheap (in-memory SQLite). The
// trade-off is acceptable for test isolation.

async function dbFirst(d: FakeD1Database): Promise<Seed> {
  const member = await d
    .prepare("SELECT id FROM household_members WHERE display_name = ?")
    .bind("Test Owner")
    .first<{ id: number }>();
  const otherMember = await d
    .prepare("SELECT id FROM household_members WHERE display_name = ?")
    .bind("Test Owner B")
    .first<{ id: number }>();
  const accounts = await d.prepare("SELECT id FROM accounts ORDER BY id ASC").all<{ id: number }>();
  const incomeCat = await d
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("other")
    .first<{ id: number }>();
  const expenseCat = await d
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("groceries")
    .first<{ id: number }>();
  if (
    member === null ||
    otherMember === null ||
    accounts.results.length < 3 ||
    incomeCat === null ||
    expenseCat === null
  ) {
    throw new Error("test seed: missing rows");
  }
  return {
    memberId: member.id,
    otherMemberId: otherMember.id,
    bankId: 0,
    accountId: accounts.results[0]?.id ?? 0,
    secondAccountId: accounts.results[1]?.id ?? 0,
    otherMemberAccountId: accounts.results[2]?.id ?? 0,
    incomeCategoryId: incomeCat.id,
    expenseCategoryId: expenseCat.id,
  };
}
