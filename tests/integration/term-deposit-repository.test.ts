/**
 * Term-deposit D1 repository integration tests.
 *
 * Exercises the real D1 repository code path against the FakeD1Database.
 * Covers:
 *   - create / get / list / row mapping
 *   - editable-facts patch with optimistic state locking
 *   - bank-quoted facts patch
 *   - maturity-instruction update
 *   - non-closure state transitions (DRAFT -> REVIEW_REQUIRED, etc.)
 *   - predecessor / successor link storage
 *   - rejection paths: missing deposit id, bad state, closure boundary, duplicate predecessor
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import { D1TermDepositRepository, type CreateDraftInput } from "../../src/services/term-deposit/index.js";
import { seedDepositParents, type SeededParents } from "../_helpers/seed.js";

const VALID_DRAFT = (overrides: Partial<CreateDraftInput> = {}): CreateDraftInput => ({
  accountId: 0,
  bankId: 0,
  holderMemberId: 0,
  currencyCode: "PHP",
  productName: "Test TD Product",
  certificateLastFour: "1234",
  principalMinor: 10_000_000, // PHP 100,000.00
  startDate: "2026-01-01",
  maturityDate: "2026-04-01", // 90 days
  annualRateScaled: 50_000, // 5%
  taxRateScaled: 200_000, // 20%
  feesMinor: 0,
  interestMethod: "SIMPLE",
  dayCountBasis: "ACT_365",
  ...overrides,
});

let db: FakeD1Database;
let repo: D1TermDepositRepository;
let seeded: SeededParents;

beforeEach(async () => {
  db = new FakeD1Database();
  repo = new D1TermDepositRepository(db);
  seeded = await seedDepositParents(db);
});

afterEach(() => {
  db.close();
});

// ── create / get / list ─────────────────────────────────────────────────────

describe("create / get / list", () => {
  it("inserts a DRAFT row with all required columns populated", async () => {
    const record = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );

    expect(record.id).toBeGreaterThan(0);
    expect(record.state).toBe("DRAFT");
    expect(record.accountId).toBe(seeded.accountId);
    expect(record.bankId).toBe(seeded.bankId);
    expect(record.holderMemberId).toBe(seeded.memberId);
    expect(record.currencyCode).toBe("PHP");
    expect(record.certificateLastFour).toBe("1234");
    expect(record.principalMinor).toBe(10_000_000);
    expect(record.annualRateScaled).toBe(50_000);
    expect(record.taxRateScaled).toBe(200_000);
    expect(record.interestMethod).toBe("SIMPLE");
    expect(record.dayCountBasis).toBe("ACT_365");
    expect(record.bankQuotedGrossInterestMinor).toBeNull();
    expect(record.bankQuotedNetInterestMinor).toBeNull();
    expect(record.bankQuotedMaturityAmountMinor).toBeNull();
    expect(record.maturityInstruction).toBe("PENDING");
    expect(record.predecessorDepositId).toBeNull();
    expect(record.successorDepositId).toBeNull();
    expect(record.createdAt).not.toBe("");
    expect(record.updatedAt).not.toBe("");
  });

  it("row mapping preserves integer money and rate fields through the SQLite round-trip", async () => {
    // Round-trip an integer through the SQLite path. The result must be
    // exactly the same integer; no truncation or representation drift.
    const record = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        principalMinor: 7_777_777,
        annualRateScaled: 12_345,
        taxRateScaled: 6_789,
      })
    );
    expect(Number.isSafeInteger(record.principalMinor)).toBe(true);
    expect(record.principalMinor).toBe(7_777_777);
    expect(record.annualRateScaled).toBe(12_345);
    expect(record.taxRateScaled).toBe(6_789);
  });

  it("findById returns the inserted record", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    const fetched = await repo.findById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.productName).toBe("Test TD Product");
  });

  it("findById returns null for an unknown id", async () => {
    const fetched = await repo.findById(999_999);
    expect(fetched).toBeNull();
  });

  it("listByHolder returns rows ordered by maturity_date ASC, id ASC", async () => {
    // Insert three rows for the same holder with different maturities.
    const a = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        maturityDate: "2026-07-01",
        productName: "A (Jul)",
      })
    );
    const b = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        maturityDate: "2026-04-01",
        productName: "B (Apr)",
      })
    );
    const c = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        maturityDate: "2026-04-01",
        productName: "C (Apr, same day)",
      })
    );

    const list = await repo.listByHolder(seeded.memberId);
    expect(list).toHaveLength(3);
    expect(list[0]?.id).toBe(b.id); // earliest
    expect(list[1]?.id).toBe(c.id); // same day -> id ASC
    expect(list[2]?.id).toBe(a.id);
  });

  it("listByHolder returns only rows for the specified holder", async () => {
    await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        productName: "Mine",
      })
    );

    // Insert a second holder + their own TERM_DEPOSIT account.
    await db.prepare("INSERT INTO banks (slug, name) VALUES (?, ?)").bind("third-bank", "Third Bank").run();
    const m3 = await db
      .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
      .bind("OWNER", "Other Holder")
      .run();
    const b3 = await db
      .prepare("SELECT id FROM banks WHERE slug = ?")
      .bind("third-bank")
      .first<{ id: number }>();
    const a3 = await db
      .prepare(
        `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(m3.meta.last_row_id, b3?.id, "PHP", "TERM_DEPOSIT", "Other TD")
      .run();
    await repo.insertDraft(
      VALID_DRAFT({
        accountId: Number(a3.meta.last_row_id),
        bankId: Number(b3?.id),
        holderMemberId: Number(m3.meta.last_row_id),
        productName: "Theirs",
      })
    );

    const mine = await repo.listByHolder(seeded.memberId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.productName).toBe("Mine");

    const theirs = await repo.listByHolder(Number(m3.meta.last_row_id));
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.productName).toBe("Theirs");
  });

  it("inserts with optional bank-quoted facts populated", async () => {
    const record = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        bankQuotedGrossInterestMinor: 1_500_00,
        bankQuotedNetInterestMinor: 1_200_00,
        bankQuotedMaturityAmountMinor: 101_200_00,
      })
    );
    expect(record.bankQuotedGrossInterestMinor).toBe(1_500_00);
    expect(record.bankQuotedNetInterestMinor).toBe(1_200_00);
    expect(record.bankQuotedMaturityAmountMinor).toBe(101_200_00);
  });
});

// ── editable-facts update ──────────────────────────────────────────────────

describe("updateEditableFacts", () => {
  it("patches allowed fields while in DRAFT", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    const updated = await repo.updateEditableFacts(
      created.id,
      {
        principalMinor: 12_000_000,
        annualRateScaled: 75_000, // 7.5%
        certificateLastFour: "5678",
        nickname: "Renamed TD",
        productName: "Renamed Product",
      },
      ["DRAFT", "REVIEW_REQUIRED"]
    );

    expect(updated.principalMinor).toBe(12_000_000);
    expect(updated.annualRateScaled).toBe(75_000);
    expect(updated.certificateLastFour).toBe("5678");
    expect(updated.nickname).toBe("Renamed TD");
    expect(updated.productName).toBe("Renamed Product");
    // Untouched fields remain identical.
    expect(updated.taxRateScaled).toBe(200_000);
    expect(updated.dayCountBasis).toBe("ACT_365");
  });

  it("updates updated_at on a successful patch", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    const originalUpdatedAt = created.updatedAt;
    // SQLite datetime('now') has second-level precision; wait long enough to
    // cross a second boundary before the next write so the strict greater-than
    // comparison actually proves the timestamp changed.
    await new Promise((r) => setTimeout(r, 1100));
    const updated = await repo.updateEditableFacts(created.id, { principalMinor: 9_000_000 }, [
      "DRAFT",
      "REVIEW_REQUIRED",
    ]);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(originalUpdatedAt).getTime());
  });

  it("rejects a patch once the row has moved to ACTIVE", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    await repo.transitionState(created.id, "DRAFT", "REVIEW_REQUIRED");
    await repo.transitionState(created.id, "REVIEW_REQUIRED", "ACTIVE");

    await expect(
      repo.updateEditableFacts(created.id, { principalMinor: 1 }, ["DRAFT", "REVIEW_REQUIRED"])
    ).rejects.toThrow(/not in allowed states/);
  });

  it("no-op patch returns the current row unchanged", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    const result = await repo.updateEditableFacts(created.id, {}, ["DRAFT", "REVIEW_REQUIRED"]);
    expect(result.id).toBe(created.id);
    expect(result.principalMinor).toBe(10_000_000);
  });

  it("throws when the deposit id does not exist", async () => {
    await expect(
      repo.updateEditableFacts(999_999, { principalMinor: 1 }, ["DRAFT", "REVIEW_REQUIRED"])
    ).rejects.toThrow(/not found/);
  });
});

// ── bank-quoted facts ──────────────────────────────────────────────────────

describe("updateBankQuotedFacts", () => {
  it("updates bank-quoted columns verbatim", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    const updated = await repo.updateBankQuotedFacts(created.id, { bankQuotedGrossInterestMinor: 1_500_00 }, [
      "DRAFT",
      "REVIEW_REQUIRED",
      "ACTIVE",
    ]);
    expect(updated.bankQuotedGrossInterestMinor).toBe(1_500_00);
    expect(updated.bankQuotedNetInterestMinor).toBeNull();
    expect(updated.bankQuotedMaturityAmountMinor).toBeNull();
  });

  it("can clear a bank-quoted column to null", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        bankQuotedGrossInterestMinor: 1_500_00,
      })
    );
    expect(created.bankQuotedGrossInterestMinor).toBe(1_500_00);

    const updated = await repo.updateBankQuotedFacts(created.id, { bankQuotedGrossInterestMinor: null }, [
      "DRAFT",
      "REVIEW_REQUIRED",
      "ACTIVE",
    ]);
    expect(updated.bankQuotedGrossInterestMinor).toBeNull();
  });

  it("rejects update outside allowed states", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    await repo.transitionState(created.id, "DRAFT", "REVIEW_REQUIRED");
    await repo.transitionState(created.id, "REVIEW_REQUIRED", "ACTIVE");
    await repo.transitionState(created.id, "ACTIVE", "MATURED_ACTION_REQUIRED");

    await expect(
      repo.updateBankQuotedFacts(created.id, { bankQuotedGrossInterestMinor: 1 }, [
        "DRAFT",
        "REVIEW_REQUIRED",
        "ACTIVE",
      ])
    ).rejects.toThrow(/not in allowed states/);
  });
});

// ── maturity instruction ───────────────────────────────────────────────────

describe("updateMaturityInstruction", () => {
  it("updates the planned instruction + optional settlement account", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    const updated = await repo.updateMaturityInstruction(created.id, "SETTLE_TO_ACCOUNT", seeded.accountId, [
      "DRAFT",
      "REVIEW_REQUIRED",
    ]);
    expect(updated.maturityInstruction).toBe("SETTLE_TO_ACCOUNT");
    expect(updated.maturitySettlementAccountId).toBe(seeded.accountId);
  });
});

// ── non-closure state transitions ──────────────────────────────────────────

describe("non-closure state transitions", () => {
  it("DRAFT -> REVIEW_REQUIRED succeeds", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    const result = await repo.transitionState(created.id, "DRAFT", "REVIEW_REQUIRED");
    expect(result.affected).toBe(1);
    expect(result.record?.state).toBe("REVIEW_REQUIRED");
  });

  it("stale expected-from causes 0 rows affected", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    // Try to transition expecting REVIEW_REQUIRED when the row is still DRAFT.
    const result = await repo.transitionState(created.id, "REVIEW_REQUIRED", "ACTIVE");
    expect(result.affected).toBe(0);
    expect(result.record).toBeNull();
  });

  it("rejects closure transitions at the repository boundary with zero mutation", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    await repo.transitionState(created.id, "DRAFT", "REVIEW_REQUIRED");
    await repo.transitionState(created.id, "REVIEW_REQUIRED", "ACTIVE");
    await repo.transitionState(created.id, "ACTIVE", "MATURED_ACTION_REQUIRED");

    await expect(
      repo.transitionState(created.id, "MATURED_ACTION_REQUIRED", "SETTLED_TO_ACCOUNT")
    ).rejects.toThrow(/not available in M1B/);

    const unchanged = await repo.findById(created.id);
    expect(unchanged?.state).toBe("MATURED_ACTION_REQUIRED");
    expect(unchanged?.settlementEvidenceRef).toBeNull();
  });
});

// ── empty allowedStates guard ──────────────────────────────────────────────

describe("empty allowedStates guard", () => {
  it("updateEditableFacts rejects an empty allowedStates array before SQL", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    await expect(repo.updateEditableFacts(created.id, { productName: "X" }, [])).rejects.toThrow(
      /allowedStates must contain at least one state/
    );
  });

  it("updateBankQuotedFacts rejects an empty allowedStates array before SQL", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    await expect(
      repo.updateBankQuotedFacts(created.id, { bankQuotedGrossInterestMinor: 100 }, [])
    ).rejects.toThrow(/allowedStates must contain at least one state/);
  });

  it("updateMaturityInstruction rejects an empty allowedStates array before SQL", async () => {
    const created = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    await expect(repo.updateMaturityInstruction(created.id, "SETTLE_TO_ACCOUNT", null, [])).rejects.toThrow(
      /allowedStates must contain at least one state/
    );
  });
});

// ── predecessor / successor link storage ──────────────────────────────────

describe("predecessor / successor links", () => {
  it("createDraft stores a predecessor id and loadPredecessor resolves it", async () => {
    const pred = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        productName: "Predecessor",
      })
    );
    const succ = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        productName: "Successor",
        predecessorDepositId: pred.id,
      })
    );

    expect(succ.predecessorDepositId).toBe(pred.id);
    const loaded = await repo.loadPredecessor(succ.id);
    expect(loaded?.id).toBe(pred.id);
    expect(loaded?.productName).toBe("Predecessor");
  });

  it("loadSuccessor resolves a persisted renewal link", async () => {
    const a = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        productName: "A",
      })
    );
    const b = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        productName: "B",
        predecessorDepositId: a.id,
      })
    );

    const successor = await repo.loadSuccessor(a.id);
    expect(successor?.id).toBe(b.id);

    const predecessor = await repo.loadPredecessor(b.id);
    expect(predecessor?.id).toBe(a.id);
  });

  it("insertDraft rejects a second deposit pointing to the same predecessor (UNIQUE race boundary)", async () => {
    const pred = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        productName: "Predecessor",
      })
    );
    await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        productName: "First Successor",
        predecessorDepositId: pred.id,
      })
    );

    await expect(
      repo.insertDraft(
        VALID_DRAFT({
          accountId: seeded.accountId,
          bankId: seeded.bankId,
          holderMemberId: seeded.memberId,
          productName: "Second Successor",
          predecessorDepositId: pred.id,
        })
      )
    ).rejects.toThrow(/UNIQUE/);

    // The first successor row remains the sole successor.
    const successor = await repo.loadSuccessor(pred.id);
    expect(successor?.productName).toBe("First Successor");
  });
});

// ── linked-parent context reads ───────────────────────────────────────────

describe("linked-parent context reads", () => {
  it("loadAccountContext returns the TERM_DEPOSIT account metadata", async () => {
    const ctx = await repo.loadAccountContext(seeded.accountId);
    expect(ctx).not.toBeNull();
    expect(ctx?.accountType).toBe("TERM_DEPOSIT");
    expect(ctx?.memberId).toBe(seeded.memberId);
    expect(ctx?.bankId).toBe(seeded.bankId);
    expect(ctx?.currencyCode).toBe(seeded.currency);
  });

  it("loadAccountContext returns null for an unknown account", async () => {
    const ctx = await repo.loadAccountContext(999_999);
    expect(ctx).toBeNull();
  });

  it("loadMemberContext / loadBankContext / loadCurrencyContext return their rows", async () => {
    const m = await repo.loadMemberContext(seeded.memberId);
    expect(m?.memberId).toBe(seeded.memberId);

    const b = await repo.loadBankContext(seeded.bankId);
    expect(b?.bankId).toBe(seeded.bankId);

    const c = await repo.loadCurrencyContext("PHP");
    expect(c?.code).toBe("PHP");
  });

  it("loadDepositContext returns the id when present", async () => {
    const record = await repo.insertDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    const ctx = await repo.loadDepositContext(record.id);
    expect(ctx?.id).toBe(record.id);
  });
});
