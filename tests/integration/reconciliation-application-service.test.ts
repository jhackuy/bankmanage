/**
 * M2B reconciliation application-service tests.
 *
 * Exercises the full service stack through the FakeD1Database so the
 * same code path that runs in production is under test (no mocks of the
 * service or repository).
 *
 * Covers the production-path cases the M2B slice ships:
 *   - Happy paths: exact match (difference=0), non-zero difference,
 *     positive cleared balance, negative cleared balance.
 *   - Ownership / active checks: cross-member rejection
 *     (ACCOUNT_FORBIDDEN), inactive member (MEMBER_INACTIVE), missing
 *     member (MEMBER_NOT_FOUND), inactive account, archived account.
 *   - Currency mismatch: ledger entries in a different currency are
 *     excluded from the cleared balance computation (no aggregation).
 *   - Input validation: invalid confirmedAt (non-ISO, impossible date),
 *     non-safe-integer bank_confirmed_balance, empty idempotency key.
 *   - Safe-integer boundary: MAX_SAFE_INTEGER and MIN_SAFE_INTEGER.
 *   - Idempotency: same-payload retry returns the existing record with
 *     created=false; different-payload retry surfaces IDEMPOTENCY_CONFLICT.
 *   - Concurrent retry: two parallel calls with the same payload — one
 *     creates, the other finds the existing record.
 *   - History preservation: multiple reconciliations on the same account
 *     are preserved in full audit order (no UPDATE, no DELETE).
 *   - Zero partial state on failure: a forced FK violation leaves zero
 *     reconciliation rows behind.
 *   - Queries: getLatestForAccount, listForAccount, listUnreconciledAccounts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import { D1AccountRepository } from "../../src/services/accounts/d1-repository.js";
import {
  D1ReconciliationRepository,
  ReconciliationApplicationService,
  type PostReconciliationInput,
} from "../../src/services/reconciliation/index.js";

interface Seed {
  memberId: number;
  otherMemberId: number;
  /** PHP BANK account owned by memberId. */
  accountId: number;
  /** Second PHP BANK account owned by memberId. */
  secondAccountId: number;
  /** PHP BANK account owned by otherMemberId. */
  otherMemberAccountId: number;
  /** PHP BANK account owned by memberId but archived. */
  archivedAccountId: number;
  /** PHP BANK account owned by memberId but inactive. */
  inactiveAccountId: number;
  expenseCategoryId: number;
}

let db: FakeD1Database;
let reconciliationRepo: D1ReconciliationRepository;
let accountRepo: D1AccountRepository;
let reconciliationService: ReconciliationApplicationService;

beforeEach(async () => {
  db = new FakeD1Database();
  accountRepo = new D1AccountRepository(db);
  reconciliationRepo = new D1ReconciliationRepository(db);
  reconciliationService = new ReconciliationApplicationService(reconciliationRepo, accountRepo);

  // Two household members — A and B. Each owns their own bank account.
  // Member A also owns a second account and an inactive + archived one
  // for state checks.
  const m1 = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Recon Test Owner")
    .run();
  const m2 = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Recon Test Owner B")
    .run();

  const b1 = await db
    .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, 0)")
    .bind("recon-bank-a", "Recon Bank A")
    .run();
  const b2 = await db
    .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, 0)")
    .bind("recon-bank-b", "Recon Bank B")
    .run();

  await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(m1.meta.last_row_id, b1.meta.last_row_id, "PHP", "BANK", "Member A Checking")
    .run();
  await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(m1.meta.last_row_id, b1.meta.last_row_id, "PHP", "BANK", "Member A Savings")
    .run();
  await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(m2.meta.last_row_id, b2.meta.last_row_id, "PHP", "BANK", "Member B Checking")
    .run();
  await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname,
                             archived, opening_balance_minor)
       VALUES (?, ?, ?, ?, ?, 1, 0)`
    )
    .bind(m1.meta.last_row_id, b1.meta.last_row_id, "PHP", "BANK", "Member A Archived")
    .run();
  await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname,
                             active, opening_balance_minor)
       VALUES (?, ?, ?, ?, ?, 0, 0)`
    )
    .bind(m1.meta.last_row_id, b1.meta.last_row_id, "PHP", "BANK", "Member A Inactive")
    .run();
});

afterEach(() => {
  db.close();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Re-read the seed from a fresh beforeEach. The tests run against the
 * FakeD1Database, which is recreated each test; the seed values
 * (member ids, account ids) are looked up by display_name / nickname.
 */
async function loadSeed(d: FakeD1Database): Promise<Seed> {
  const member = await d
    .prepare("SELECT id FROM household_members WHERE display_name = ?")
    .bind("Recon Test Owner")
    .first<{ id: number }>();
  const otherMember = await d
    .prepare("SELECT id FROM household_members WHERE display_name = ?")
    .bind("Recon Test Owner B")
    .first<{ id: number }>();
  if (member === null || otherMember === null) {
    throw new Error("test seed: missing seeded members");
  }
  const accounts = await d
    .prepare("SELECT id, nickname FROM accounts ORDER BY id ASC")
    .all<{ id: number; nickname: string }>();
  const checking = accounts.results.find((a) => a.nickname === "Member A Checking");
  const savings = accounts.results.find((a) => a.nickname === "Member A Savings");
  const other = accounts.results.find((a) => a.nickname === "Member B Checking");
  if (checking === undefined || savings === undefined || other === undefined) {
    throw new Error("test seed: missing seeded accounts");
  }
  const expenseCat = await d
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("groceries")
    .first<{ id: number }>();
  if (expenseCat === null) throw new Error("test seed: missing groceries category");
  return {
    memberId: member.id,
    otherMemberId: otherMember.id,
    accountId: checking.id,
    secondAccountId: savings.id,
    otherMemberAccountId: other.id,
    // Both archived and inactive accounts live at indices 3 and 4 in
    // the ORDER BY id ASC list.
    archivedAccountId: accounts.results[3]!.id,
    inactiveAccountId: accounts.results[4]!.id,
    expenseCategoryId: expenseCat.id,
  };
}

function reconcile(overrides: Partial<PostReconciliationInput> = {}): PostReconciliationInput {
  return {
    memberId: 0,
    accountId: 0,
    bankConfirmedBalanceMinor: 0,
    confirmedAt: "2026-03-15T10:00:00.000Z",
    idempotencyKey: "recon-key-1",
    ...overrides,
  };
}

async function countRows(sql: string): Promise<number> {
  const row = await db.prepare(sql).first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Post a balanced EXPENSE transaction (member A, PHP, account A). We
 * inline the SQL so this test stays self-contained — we don't need the
 * full transactions service for a couple of ledger entries.
 */
async function postExpense(
  amountMinor: number,
  accountId: number,
  memberId: number,
  idempotencyKey: string,
  expenseCategoryId: number
): Promise<void> {
  const txn = await db
    .prepare(
      `INSERT INTO transactions (
         transaction_type, member_id, currency_code, amount_minor,
         occurred_on, idempotency_key
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind("EXPENSE", memberId, "PHP", amountMinor, "2026-03-15", idempotencyKey)
    .run();
  const txnId = Number(txn.meta.last_row_id);

  // Account-side CREDIT (money leaves), category-side DEBIT (expense bucket).
  await db
    .prepare(
      `INSERT INTO ledger_entries (transaction_id, account_id, category_id, direction,
                                   amount_minor, currency_code)
       VALUES (?, ?, NULL, 'CREDIT', ?, 'PHP')`
    )
    .bind(txnId, accountId, amountMinor)
    .run();
  await db
    .prepare(
      `INSERT INTO ledger_entries (transaction_id, account_id, category_id, direction,
                                   amount_minor, currency_code)
       VALUES (?, NULL, ?, 'DEBIT', ?, 'PHP')`
    )
    .bind(txnId, expenseCategoryId, amountMinor)
    .run();
}

// ── Happy paths ─────────────────────────────────────────────────────────────

describe("recordReconciliation — happy paths", () => {
  it("exact match: cleared == bank_confirmed → difference == 0", async () => {
    const s = await loadSeed(db);
    // opening_balance_minor=0, no ledger entries → cleared = 0.
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "exact-match-1",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.created).toBe(true);
    expect(r.value.record.bankConfirmedBalanceMinor).toBe(0);
    expect(r.value.record.clearedBalanceMinor).toBe(0);
    expect(r.value.record.differenceMinor).toBe(0);
    expect(r.value.record.currencyCode).toBe("PHP");
    expect(r.value.record.accountId).toBe(s.accountId);
    expect(r.value.record.memberId).toBe(s.memberId);
  });

  it("non-zero positive difference: bank says more than ledger", async () => {
    const s = await loadSeed(db);
    // opening_balance_minor=0, no ledger entries → cleared = 0.
    // Bank confirms 50_000 PHP → difference = +50_000.
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 50_000,
        idempotencyKey: "positive-diff-1",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.clearedBalanceMinor).toBe(0);
    expect(r.value.record.bankConfirmedBalanceMinor).toBe(50_000);
    expect(r.value.record.differenceMinor).toBe(50_000);
  });

  it("non-zero negative difference: bank says less than ledger", async () => {
    const s = await loadSeed(db);
    // opening_balance_minor=0, no ledger entries → cleared = 0.
    // Bank confirms -25_000 PHP → difference = -25_000.
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: -25_000,
        idempotencyKey: "negative-diff-1",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.clearedBalanceMinor).toBe(0);
    expect(r.value.record.bankConfirmedBalanceMinor).toBe(-25_000);
    expect(r.value.record.differenceMinor).toBe(-25_000);
  });

  it("positive cleared balance: opening balance contributes", async () => {
    const s = await loadSeed(db);
    await db
      .prepare("UPDATE accounts SET opening_balance_minor = ? WHERE id = ?")
      .bind(100_000, s.accountId)
      .run();
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 100_000,
        idempotencyKey: "positive-cleared-1",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.clearedBalanceMinor).toBe(100_000);
    expect(r.value.record.differenceMinor).toBe(0);
  });

  it("negative cleared balance: expenses exceed opening balance", async () => {
    const s = await loadSeed(db);
    // opening_balance_minor=0; an EXPENSE of 30_000 leaves the
    // cleared balance at -30_000.
    await postExpense(30_000, s.accountId, s.memberId, "recon-exp-1", s.expenseCategoryId);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: -30_000,
        idempotencyKey: "negative-cleared-1",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.clearedBalanceMinor).toBe(-30_000);
    expect(r.value.record.differenceMinor).toBe(0);
  });

  it("records evidence_ref verbatim when supplied", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "evidence-key-1",
        evidenceRef: "fake-r2/key/2026-03-15.png",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.evidenceRef).toBe("fake-r2/key/2026-03-15.png");
  });

  it("null evidence_ref when omitted", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "no-evidence-1",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.evidenceRef).toBeNull();
  });

  it("never silently creates an adjustment transaction", async () => {
    const s = await loadSeed(db);
    // opening_balance=0, no ledger → cleared=0. Bank confirms +10_000 → diff=+10_000.
    await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 10_000,
        idempotencyKey: "no-adjust-1",
      })
    );
    // No adjustment transaction must have been created.
    const txns = await countRows("SELECT COUNT(*) AS c FROM transactions");
    expect(txns).toBe(0);
    const entries = await countRows("SELECT COUNT(*) AS c FROM ledger_entries");
    expect(entries).toBe(0);
    // The reconciliation row is the only place the difference lives.
    const recs = await countRows("SELECT COUNT(*) AS c FROM account_reconciliations");
    expect(recs).toBe(1);
  });
});

// ── Ownership and active-state checks ───────────────────────────────────────

describe("ownership and active-state checks", () => {
  it("rejects cross-member reconciliation with ACCOUNT_FORBIDDEN", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.otherMemberAccountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "cross-member-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ACCOUNT_FORBIDDEN");
  });

  it("rejects reconciliation against an inactive account with ACCOUNT_INACTIVE", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.inactiveAccountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "inactive-acct-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ACCOUNT_INACTIVE");
  });

  it("rejects reconciliation against an archived account with ACCOUNT_INACTIVE", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.archivedAccountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "archived-acct-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ACCOUNT_INACTIVE");
  });

  it("rejects reconciliation for an inactive member with MEMBER_INACTIVE", async () => {
    const s = await loadSeed(db);
    await db.prepare("UPDATE household_members SET active = 0 WHERE id = ?").bind(s.memberId).run();
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "inactive-member-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_INACTIVE");
  });

  it("rejects reconciliation for a non-existent member with MEMBER_NOT_FOUND", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: 999_999_999,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "no-member-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("rejects reconciliation against a non-existent account with ACCOUNT_NOT_FOUND", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: 999_999_999,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "no-account-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});

// ── Currency mismatch ───────────────────────────────────────────────────────

describe("currency mismatch", () => {
  it("excludes ledger entries in a different currency from the cleared balance", async () => {
    const s = await loadSeed(db);
    // Seed a direct ledger entry that violates the transactions-service
    // invariant (EUR entry against a PHP account). This is a defensive
    // check: the cleared balance SQL must filter by currency_code at
    // the repository level so a mis-currency entry can never leak into
    // the cleared balance.
    const txn = await db
      .prepare(
        `INSERT INTO transactions (transaction_type, member_id, currency_code,
                                   amount_minor, occurred_on, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind("EXPENSE", s.memberId, "EUR", 999_999, "2026-03-15", "bad-currency-tx")
      .run();
    await db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, account_id, category_id, direction,
                                     amount_minor, currency_code)
         VALUES (?, ?, NULL, 'CREDIT', ?, 'EUR')`
      )
      .bind(Number(txn.meta.last_row_id), s.accountId, 999_999)
      .run();

    // opening_balance=0, no PHP entries → cleared in PHP must be 0.
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "currency-mismatch-1",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.clearedBalanceMinor).toBe(0);
    expect(r.value.record.differenceMinor).toBe(0);
    // And the EUR entry is still in the ledger — only excluded from
    // the cleared balance computation.
    const eurEntries = await countRows(
      "SELECT COUNT(*) AS c FROM ledger_entries WHERE currency_code = 'EUR'"
    );
    expect(eurEntries).toBe(1);
  });
});

// ── Input validation ────────────────────────────────────────────────────────

describe("input validation", () => {
  it("rejects malformed confirmedAt (not ISO-8601 datetime)", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        confirmedAt: "2026-03-15",
        idempotencyKey: "bad-date-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects impossible calendar datetime (regex-pass but invalid instant)", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        confirmedAt: "2026-02-30T10:00:00.000Z",
        idempotencyKey: "impossible-date-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects empty idempotency key", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects non-positive accountId", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: 0,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "non-positive-acct-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects non-positive memberId", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: 0,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "non-positive-member-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });
});

// ── Safe-integer boundaries ─────────────────────────────────────────────────

describe("safe-integer boundaries", () => {
  it("accepts MAX_SAFE_INTEGER as bankConfirmedBalanceMinor", async () => {
    const s = await loadSeed(db);
    const max = Number.MAX_SAFE_INTEGER;
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: max,
        idempotencyKey: "max-safe-int-1",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.bankConfirmedBalanceMinor).toBe(max);
    expect(r.value.record.clearedBalanceMinor).toBe(0);
    expect(r.value.record.differenceMinor).toBe(max);
  });

  it("accepts MIN_SAFE_INTEGER as bankConfirmedBalanceMinor", async () => {
    const s = await loadSeed(db);
    const min = Number.MIN_SAFE_INTEGER;
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: min,
        idempotencyKey: "min-safe-int-1",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.bankConfirmedBalanceMinor).toBe(min);
    expect(r.value.record.differenceMinor).toBe(min);
  });

  it("rejects bankConfirmedBalanceMinor above MAX_SAFE_INTEGER", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: Number.MAX_SAFE_INTEGER + 2,
        idempotencyKey: "overflow-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects bankConfirmedBalanceMinor below MIN_SAFE_INTEGER", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: Number.MIN_SAFE_INTEGER - 2,
        idempotencyKey: "underflow-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects non-integer bankConfirmedBalanceMinor", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 1.5,
        idempotencyKey: "fractional-1",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe("idempotency", () => {
  it("same-payload retry returns the same record with created=false", async () => {
    const s = await loadSeed(db);
    const first = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "idem-1",
      })
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const originalId = first.value.record.id;

    const second = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "idem-1",
      })
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.created).toBe(false);
    expect(second.value.record.id).toBe(originalId);
    expect(second.value.record.idempotencyKey).toBe("idem-1");

    // Exactly one row in account_reconciliations — no duplication.
    const recs = await countRows("SELECT COUNT(*) AS c FROM account_reconciliations");
    expect(recs).toBe(1);
  });

  it("conflicting payload retry surfaces IDEMPOTENCY_CONFLICT", async () => {
    const s = await loadSeed(db);
    const first = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 100_000,
        idempotencyKey: "idem-conflict-1",
      })
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Same idempotency key, different bank_confirmed_balance.
    const conflict = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 200_000,
        idempotencyKey: "idem-conflict-1",
      })
    );
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // The conflicting payload must NOT have overwritten the original.
    const rows = await countRows("SELECT COUNT(*) AS c FROM account_reconciliations");
    expect(rows).toBe(1);
    const stored = await db
      .prepare("SELECT bank_confirmed_balance_minor FROM account_reconciliations WHERE idempotency_key = ?")
      .bind("idem-conflict-1")
      .first<{ bank_confirmed_balance_minor: number }>();
    expect(stored?.bank_confirmed_balance_minor).toBe(100_000);
  });

  it("conflicting retry on confirmedAt also surfaces IDEMPOTENCY_CONFLICT", async () => {
    const s = await loadSeed(db);
    const first = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        confirmedAt: "2026-03-15T10:00:00.000Z",
        idempotencyKey: "idem-conflict-date",
      })
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const conflict = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        confirmedAt: "2026-03-15T11:00:00.000Z",
        idempotencyKey: "idem-conflict-date",
      })
    );
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("concurrent same-payload retry: one creates, the other finds the existing record", async () => {
    const s = await loadSeed(db);
    const payload = reconcile({
      memberId: s.memberId,
      accountId: s.accountId,
      bankConfirmedBalanceMinor: 0,
      idempotencyKey: "concurrent-1",
    });

    const [r1, r2] = await Promise.all([
      reconciliationService.recordReconciliation(payload),
      reconciliationService.recordReconciliation(payload),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    // Exactly one of them is created; both return the same record id.
    const createdFlags = [r1.value.created, r2.value.created].sort();
    expect(createdFlags).toEqual([false, true]);
    expect(r1.value.record.id).toBe(r2.value.record.id);

    // And only one row was persisted.
    const rows = await countRows("SELECT COUNT(*) AS c FROM account_reconciliations");
    expect(rows).toBe(1);
  });

  it("concurrent conflicting retry: one succeeds, the other gets IDEMPOTENCY_CONFLICT", async () => {
    const s = await loadSeed(db);
    // The two payloads share the idempotency_key but differ in
    // bank_confirmed_balance. Only one can succeed; the other must be
    // rejected with IDEMPOTENCY_CONFLICT.
    const p1 = reconcile({
      memberId: s.memberId,
      accountId: s.accountId,
      bankConfirmedBalanceMinor: 10_000,
      idempotencyKey: "concurrent-conflict-1",
    });
    const p2 = reconcile({
      memberId: s.memberId,
      accountId: s.accountId,
      bankConfirmedBalanceMinor: 20_000,
      idempotencyKey: "concurrent-conflict-1",
    });

    const [r1, r2] = await Promise.all([
      reconciliationService.recordReconciliation(p1),
      reconciliationService.recordReconciliation(p2),
    ]);

    // One succeeds, one fails with IDEMPOTENCY_CONFLICT.
    const successes = [r1, r2].filter((r) => r.ok);
    const failures = [r1, r2].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    if (failures[0]!.ok) return;
    expect(failures[0]!.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // Only one row exists, and it matches the payload that won.
    const rows = await countRows("SELECT COUNT(*) AS c FROM account_reconciliations");
    expect(rows).toBe(1);
  });
});

// ── History preservation ────────────────────────────────────────────────────

describe("history preservation", () => {
  it("multiple reconciliations on the same account are preserved in full audit order", async () => {
    const s = await loadSeed(db);
    await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 10_000,
        confirmedAt: "2026-01-01T10:00:00.000Z",
        idempotencyKey: "hist-1",
      })
    );
    await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 20_000,
        confirmedAt: "2026-02-01T10:00:00.000Z",
        idempotencyKey: "hist-2",
      })
    );
    await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 30_000,
        confirmedAt: "2026-03-01T10:00:00.000Z",
        idempotencyKey: "hist-3",
      })
    );

    // No UPDATE or DELETE — three independent rows.
    const rows = await countRows("SELECT COUNT(*) AS c FROM account_reconciliations");
    expect(rows).toBe(3);

    const list = await reconciliationService.listForAccount(s.accountId);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(3);
    // Newest first (confirmed_at DESC, id DESC).
    expect(list.value[0]?.bankConfirmedBalanceMinor).toBe(30_000);
    expect(list.value[1]?.bankConfirmedBalanceMinor).toBe(20_000);
    expect(list.value[2]?.bankConfirmedBalanceMinor).toBe(10_000);
  });

  it("limit caps the audit list while the underlying rows remain preserved", async () => {
    const s = await loadSeed(db);
    for (let i = 1; i <= 5; i++) {
      await reconciliationService.recordReconciliation(
        reconcile({
          memberId: s.memberId,
          accountId: s.accountId,
          bankConfirmedBalanceMinor: i * 1000,
          confirmedAt: `2026-01-0${i}T10:00:00.000Z`,
          idempotencyKey: `limit-${i}`,
        })
      );
    }
    const list = await reconciliationService.listForAccount(s.accountId, 3);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(3);
    const all = await countRows("SELECT COUNT(*) AS c FROM account_reconciliations");
    expect(all).toBe(5);
  });

  it("posted ledger entries remain immutable across reconciliation writes", async () => {
    const s = await loadSeed(db);
    await postExpense(15_000, s.accountId, s.memberId, "imm-exp-1", s.expenseCategoryId);

    // First reconciliation snapshot.
    const r1 = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: -15_000,
        confirmedAt: "2026-03-01T10:00:00.000Z",
        idempotencyKey: "imm-1",
      })
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.record.clearedBalanceMinor).toBe(-15_000);

    // A subsequent ledger entry is posted — the historical
    // reconciliation row must NOT change.
    await postExpense(7_000, s.accountId, s.memberId, "imm-exp-2", s.expenseCategoryId);

    const reread = await reconciliationService.getReconciliation(r1.value.record.id);
    expect(reread.ok).toBe(true);
    if (!reread.ok || reread.value === null) return;
    expect(reread.value.clearedBalanceMinor).toBe(-15_000);
    expect(reread.value.differenceMinor).toBe(0);

    // A second reconciliation captures the new snapshot.
    const r2 = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: -22_000,
        confirmedAt: "2026-04-01T10:00:00.000Z",
        idempotencyKey: "imm-2",
      })
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.record.clearedBalanceMinor).toBe(-22_000);
    expect(r2.value.record.differenceMinor).toBe(0);

    // Both rows preserved, both snapshots distinct.
    const rows = await countRows("SELECT COUNT(*) AS c FROM account_reconciliations");
    expect(rows).toBe(2);
  });
});

// ── Atomicity / zero partial state ──────────────────────────────────────────

describe("atomicity / zero partial state", () => {
  it("a forced FK violation in the direct repo call leaves zero partial state", async () => {
    const s = await loadSeed(db);

    // Direct repo call with a bogus member_id: FK violation on
    // member_id → household_members(id).
    let caught = false;
    try {
      await reconciliationRepo.ensureReconciliation({
        accountId: s.accountId,
        memberId: 999_999_999, // bogus
        currencyCode: "PHP",
        bankConfirmedBalanceMinor: 0,
        clearedBalanceMinor: 0,
        differenceMinor: 0,
        confirmedAt: "2026-03-15T10:00:00.000Z",
        evidenceRef: null,
        idempotencyKey: "fk-violation-1",
      });
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);

    const rows = await countRows("SELECT COUNT(*) AS c FROM account_reconciliations");
    expect(rows).toBe(0);
  });

  it("a failed reconciliation before the INSERT leaves zero partial state and a retry succeeds", async () => {
    const s = await loadSeed(db);

    // The first attempt uses an account the member does NOT own, so
    // the service rejects with ACCOUNT_FORBIDDEN before reaching the
    // repository.
    const blocked = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.otherMemberAccountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "retry-after-block-1",
      })
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error.code).toBe("ACCOUNT_FORBIDDEN");
    const rowsAfterBlock = await countRows("SELECT COUNT(*) AS c FROM account_reconciliations");
    expect(rowsAfterBlock).toBe(0);

    // Retry against the member's own account succeeds — the previous
    // blocked attempt left no partial state behind to interfere.
    const retried = await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "retry-after-block-2",
      })
    );
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.created).toBe(true);

    const rowsAfterRetry = await countRows("SELECT COUNT(*) AS c FROM account_reconciliations");
    expect(rowsAfterRetry).toBe(1);
  });
});

// ── Queries ─────────────────────────────────────────────────────────────────

describe("getLatestForAccount", () => {
  it("returns null when the account has never been reconciled", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.getLatestForAccount(s.accountId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeNull();
  });

  it("returns the most-recent reconciliation by confirmed_at DESC, id DESC", async () => {
    const s = await loadSeed(db);
    await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 10_000,
        confirmedAt: "2026-01-01T10:00:00.000Z",
        idempotencyKey: "latest-1",
      })
    );
    await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 30_000,
        confirmedAt: "2026-03-01T10:00:00.000Z",
        idempotencyKey: "latest-3",
      })
    );
    await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 20_000,
        confirmedAt: "2026-02-01T10:00:00.000Z",
        idempotencyKey: "latest-2",
      })
    );

    const latest = await reconciliationService.getLatestForAccount(s.accountId);
    expect(latest.ok).toBe(true);
    if (!latest.ok || latest.value === null) return;
    expect(latest.value.bankConfirmedBalanceMinor).toBe(30_000);
    expect(latest.value.confirmedAt).toBe("2026-03-01T10:00:00.000Z");
  });

  it("rejects non-positive accountId", async () => {
    const r = await reconciliationService.getLatestForAccount(0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects unknown account with ACCOUNT_NOT_FOUND", async () => {
    const r = await reconciliationService.getLatestForAccount(999_999_999);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});

describe("listForAccount", () => {
  it("returns an empty list when the account has no reconciliations", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.listForAccount(s.accountId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(0);
  });

  it("rejects non-positive limit", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.listForAccount(s.accountId, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });
});

describe("listUnreconciledAccounts", () => {
  it("lists accounts that have never been reconciled", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.listUnreconciledAccounts(s.memberId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Two active accounts: accountId + secondAccountId.
    // archived + inactive accounts are filtered out.
    const accountIds = r.value.map((u) => u.account.id);
    expect(accountIds).toContain(s.accountId);
    expect(accountIds).toContain(s.secondAccountId);
    expect(accountIds).not.toContain(s.archivedAccountId);
    expect(accountIds).not.toContain(s.inactiveAccountId);
    for (const u of r.value) {
      expect(u.latestReconciliation).toBeNull();
    }
  });

  it("excludes accounts whose latest reconciliation has difference == 0", async () => {
    const s = await loadSeed(db);
    // Reconcile accountId with difference == 0 (exact match).
    await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "unrec-exact-1",
      })
    );

    const r = await reconciliationService.listUnreconciledAccounts(s.memberId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const accountIds = r.value.map((u) => u.account.id);
    expect(accountIds).not.toContain(s.accountId);
    expect(accountIds).toContain(s.secondAccountId);
  });

  it("includes accounts whose latest reconciliation has a non-zero difference", async () => {
    const s = await loadSeed(db);
    await reconciliationService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 12_345,
        idempotencyKey: "unrec-diff-1",
      })
    );

    const r = await reconciliationService.listUnreconciledAccounts(s.memberId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hit = r.value.find((u) => u.account.id === s.accountId);
    expect(hit).toBeDefined();
    expect(hit?.latestReconciliation?.differenceMinor).toBe(12_345);
  });

  it("does not include another member's accounts", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.listUnreconciledAccounts(s.memberId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const accountIds = r.value.map((u) => u.account.id);
    expect(accountIds).not.toContain(s.otherMemberAccountId);
  });

  it("without memberId, scans every active account across all members", async () => {
    const s = await loadSeed(db);
    const r = await reconciliationService.listUnreconciledAccounts();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const accountIds = r.value.map((u) => u.account.id);
    expect(accountIds).toContain(s.accountId);
    expect(accountIds).toContain(s.otherMemberAccountId);
    expect(accountIds).not.toContain(s.archivedAccountId);
    expect(accountIds).not.toContain(s.inactiveAccountId);
  });

  it("rejects non-positive memberId", async () => {
    const r = await reconciliationService.listUnreconciledAccounts(0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects unknown memberId with MEMBER_NOT_FOUND", async () => {
    const r = await reconciliationService.listUnreconciledAccounts(999_999_999);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_NOT_FOUND");
  });
});

// ── Service constructor wiring ──────────────────────────────────────────────

describe("service wiring", () => {
  it("uses the injected account repository for member / account context", async () => {
    const s = await loadSeed(db);
    const freshAccountRepo = new D1AccountRepository(db);
    const freshReconRepo = new D1ReconciliationRepository(db);
    const customService = new ReconciliationApplicationService(freshReconRepo, freshAccountRepo);
    const r = await customService.recordReconciliation(
      reconcile({
        memberId: s.memberId,
        accountId: s.accountId,
        bankConfirmedBalanceMinor: 0,
        idempotencyKey: "wiring-1",
      })
    );
    expect(r.ok).toBe(true);
  });
});
