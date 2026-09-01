/**
 * Term-deposit application-service tests.
 *
 * Exercises the full service stack through the FakeD1Database.
 *
 * Covers:
 *   - SPEC §4.1 regression vectors (ACT/365 and ACT/360) through the service
 *   - certificate privacy boundary (reject longer/full certificate numbers)
 *   - strict date + unsafe-integer rejection
 *   - account-type and linkage-mismatch rejection
 *   - COMPOUND rejection
 *   - allowed / denied non-closure transitions and zero-partial-mutation
 *   - bank-quoted facts do NOT alter the system estimate
 *   - predecessor / successor link reads
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import {
  D1TermDepositRepository,
  TermDepositApplicationService,
  type CreateDraftInput,
  type EditableFactsPatch,
} from "../../src/services/term-deposit/index.js";
import { seedDepositParents, seedBankAccount, type SeededParents } from "../_helpers/seed.js";

const VALID_DRAFT = (overrides: Partial<CreateDraftInput> = {}): CreateDraftInput => ({
  accountId: 0,
  bankId: 0,
  holderMemberId: 0,
  currencyCode: "PHP",
  productName: "Test TD Product",
  certificateLastFour: "1234",
  principalMinor: 10_000_000,
  startDate: "2026-01-01",
  maturityDate: "2026-04-01",
  annualRateScaled: 50_000,
  taxRateScaled: 200_000,
  feesMinor: 0,
  interestMethod: "SIMPLE",
  dayCountBasis: "ACT_365",
  ...overrides,
});

let db: FakeD1Database;
let service: TermDepositApplicationService;
let seeded: SeededParents;

beforeEach(async () => {
  db = new FakeD1Database();
  const repo = new D1TermDepositRepository(db);
  service = new TermDepositApplicationService(repo);
  seeded = await seedDepositParents(db);
});

afterEach(() => {
  db.close();
});

// ── SPEC §4.1 regression vectors through the service ───────────────────────

describe("SPEC §4.1 regression vectors", () => {
  it("ACT/365: PHP 100,000 / 5% / 90 days / 20% tax", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        startDate: "2026-01-01",
        maturityDate: "2026-04-01",
        dayCountBasis: "ACT_365",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.estimate.grossInterestMinor).toBe(123_288);
    expect(r.value.estimate.taxMinor).toBe(24_658);
    expect(r.value.estimate.netInterestMinor).toBe(98_630);
    expect(r.value.estimate.maturityAmountMinor).toBe(10_098_630);
  });

  it("ACT/360: same inputs -> PHP 1,250.00 gross / 1,000.00 net", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        startDate: "2026-01-01",
        maturityDate: "2026-04-01",
        dayCountBasis: "ACT_360",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.estimate.grossInterestMinor).toBe(125_000);
    expect(r.value.estimate.taxMinor).toBe(25_000);
    expect(r.value.estimate.netInterestMinor).toBe(100_000);
    expect(r.value.estimate.maturityAmountMinor).toBe(10_100_000);
  });

  it("getDeposit recomputes the deterministic estimate", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const fetched = await service.getDeposit(created.value.record.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok || fetched.value === null) return;
    expect(fetched.value.estimate.grossInterestMinor).toBe(123_288);
    expect(fetched.value.estimate.taxMinor).toBe(24_658);
  });

  it("listDeposits computes estimates per record", async () => {
    await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        productName: "TD A",
        dayCountBasis: "ACT_365",
      })
    );
    await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId2,
        bankId: seeded.otherBankId,
        holderMemberId: seeded.memberId,
        currencyCode: "EUR",
        productName: "TD B (EUR)",
        dayCountBasis: "ACT_360",
      })
    );
    const list = await service.listDeposits(seeded.memberId);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(2);
    const a = list.value.find((x) => x.record.productName === "TD A");
    const b = list.value.find((x) => x.record.productName === "TD B (EUR)");
    expect(a?.estimate.grossInterestMinor).toBe(123_288);
    expect(b?.estimate.grossInterestMinor).toBe(125_000);
  });
});

// ── Certificate privacy boundary ───────────────────────────────────────────

describe("certificate privacy boundary", () => {
  it("rejects a 6-character certificate string", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        certificateLastFour: "123456",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/certificate/);
  });

  it("rejects a 16-character full certificate string", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        certificateLastFour: "1234567890123456",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a 3-character certificate string (truncation attempt)", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        certificateLastFour: "123",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects alphabetic characters", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        certificateLastFour: "12A4",
      })
    );
    expect(r.ok).toBe(false);
  });
});

// ── strict date and unsafe-integer rejection ───────────────────────────────

describe("strict date + unsafe-integer rejection", () => {
  it("rejects malformed start date", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        startDate: "01/01/2026",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects impossible calendar date 2026-02-30", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        startDate: "2026-02-30",
      })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects maturity before start", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        startDate: "2026-04-01",
        maturityDate: "2026-01-01",
      })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects non-integer principal", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        principalMinor: 1.5,
      })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects unsafe integer principal above MAX_SAFE_INTEGER", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        principalMinor: Number.MAX_SAFE_INTEGER + 1,
      })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects rate above the M1A sanity ceiling", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        annualRateScaled: 1_000_000 * 1_000, // 100,000%
      })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects negative tax rate", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        taxRateScaled: -1,
      })
    );
    expect(r.ok).toBe(false);
  });
});

// ── account-type and relationship mismatch rejection ───────────────────────

describe("account-type and relationship rejection", () => {
  it("rejects a non-TERM_DEPOSIT account", async () => {
    const bankAccountId = await seedBankAccount(db, seeded.memberId, seeded.bankId);
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: bankAccountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ACCOUNT_TYPE_MISMATCH");
  });

  it("rejects holder that does not own the account", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.otherMemberId, // not the account owner
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ACCOUNT_LINKAGE_MISMATCH");
  });

  it("rejects account with mismatched bank_id", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.otherBankId, // account is bound to bankId #1
        holderMemberId: seeded.memberId,
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ACCOUNT_LINKAGE_MISMATCH");
  });

  it("rejects account with mismatched currency_code", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        currencyCode: "EUR",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ACCOUNT_LINKAGE_MISMATCH");
  });

  it("rejects unknown account id", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: 999_999,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_FOUND");
  });

  it("rejects unknown bank id", async () => {
    // Create an account that points at a phantom bank by hacking a row.
    const phantomBankId = 999_999;
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: phantomBankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("BANK_NOT_FOUND");
  });

  it("rejects unknown member id", async () => {
    // The holderMemberId is the FK to household_members. If it doesn't exist,
    // the foreign key check in the database kicks in — the service surfaces
    // MEMBER_NOT_FOUND because it queries household_members first.
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: 999_999,
      })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown predecessor id", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        predecessorDepositId: 999_999,
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("PREDECESSOR_NOT_FOUND");
  });
});

// ── COMPOUND rejection ─────────────────────────────────────────────────────

describe("COMPOUND interest rejection", () => {
  it("createDraft rejects COMPOUND explicitly", async () => {
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        interestMethod: "COMPOUND",
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/compounding-frequency/);
  });

  it("updateEditableFacts rejects switching to COMPOUND", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const r = await service.updateEditableFacts(created.value.record.id, {
      interestMethod: "COMPOUND",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });
});

// ── Editable patch boundary validation ─────────────────────────────────────

describe("editable patch boundary validation", () => {
  it("rejects invalid non-financial patch fields with zero mutation", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const invalidPatches = [
      { productName: "   " },
      { nickname: 42 },
      { dayCountBasis: "ACT_999" },
      { maturityInstruction: "AUTO_SETTLE" },
      { maturitySettlementAccountId: 0 },
      { sourceEvidenceRef: 42 },
    ] as unknown as EditableFactsPatch[];

    for (const patch of invalidPatches) {
      const result = await service.updateEditableFacts(created.value.record.id, patch);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    }

    const unchanged = await service.getDeposit(created.value.record.id);
    expect(unchanged.ok).toBe(true);
    if (!unchanged.ok || unchanged.value === null) return;
    expect(unchanged.value.record.productName).toBe("Test TD Product");
    expect(unchanged.value.record.state).toBe("DRAFT");
  });
});

// ── Allowed non-closure transitions ────────────────────────────────────────

describe("allowed non-closure transitions", () => {
  it("DRAFT -> REVIEW_REQUIRED succeeds", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const r = await service.submitForReview(created.value.record.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("REVIEW_REQUIRED");
  });

  it("DRAFT -> REVIEW_REQUIRED -> ACTIVE -> MATURED_ACTION_REQUIRED full chain", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.record.id;

    const r1 = await service.submitForReview(id);
    expect(r1.ok).toBe(true);
    const r2 = await service.activate(id);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.state).toBe("ACTIVE");
    const r3 = await service.markMatured(id);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.value.state).toBe("MATURED_ACTION_REQUIRED");
  });

  it("DRAFT -> CANCELLED succeeds", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await service.cancelDraft(created.value.record.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("CANCELLED");
  });
});

// ── Denied transitions ─────────────────────────────────────────────────────

describe("denied transitions (M1B must NOT expose closure paths)", () => {
  it("service has no method to enter SETTLED_TO_ACCOUNT directly", () => {
    // M1B intentional exclusion: there is no service method for closure
    // transitions. This is a static guard — verifying the public API.
    const exposed = Object.getOwnPropertyNames(Object.getPrototypeOf(service));
    expect(exposed).not.toContain("settleToAccount");
    expect(exposed).not.toContain("renew");
    expect(exposed).not.toContain("preterminate");
  });

  it("submitForReview from CANCELLED is rejected", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await service.cancelDraft(created.value.record.id);
    const r = await service.submitForReview(created.value.record.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ILLEGAL_TRANSITION");
  });

  it("markMatured from DRAFT is rejected", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await service.markMatured(created.value.record.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ILLEGAL_TRANSITION");
  });

  it("cancelDraft from REVIEW_REQUIRED is rejected", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await service.submitForReview(created.value.record.id);
    const r = await service.cancelDraft(created.value.record.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ILLEGAL_TRANSITION");
  });

  it("activate from DRAFT is rejected", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await service.activate(created.value.record.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ILLEGAL_TRANSITION");
  });
});

// ── zero partial mutation ──────────────────────────────────────────────────

describe("zero partial mutation on rejected operations", () => {
  it("rejected createDraft leaves zero rows in term_deposits", async () => {
    const before = await service.listDeposits(seeded.memberId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeCount = before.value.length;

    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        certificateLastFour: "12345", // 5 digits -> rejected
      })
    );
    expect(r.ok).toBe(false);

    const after = await service.listDeposits(seeded.memberId);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.length).toBe(beforeCount);
  });

  it("rejected updateEditableFacts leaves the row unchanged", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const r = await service.updateEditableFacts(created.value.record.id, {
      certificateLastFour: "ABCD", // alphabetic -> rejected
    });
    expect(r.ok).toBe(false);

    const after = await service.getDeposit(created.value.record.id);
    expect(after.ok).toBe(true);
    if (!after.ok || after.value === null) return;
    expect(after.value.record.certificateLastFour).toBe("1234");
    expect(after.value.record.state).toBe("DRAFT");
  });

  it("denied transition does not mutate the row state", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const r = await service.activate(created.value.record.id);
    expect(r.ok).toBe(false);

    const after = await service.getDeposit(created.value.record.id);
    expect(after.ok).toBe(true);
    if (!after.ok || after.value === null) return;
    expect(after.value.record.state).toBe("DRAFT");
  });
});

// ── bank-quoted facts do NOT alter the system estimate ─────────────────────

describe("bank-quoted facts do not alter the system estimate", () => {
  it("the computed estimate is unaffected by bankQuotedGrossInterestMinor", async () => {
    const baseline = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    const r = await service.updateBankQuotedFacts(baseline.value.record.id, {
      bankQuotedGrossInterestMinor: 9_999_999, // arbitrary nonsense
      bankQuotedNetInterestMinor: 8_888_888,
      bankQuotedMaturityAmountMinor: 100_000_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Re-fetch to ensure estimate is freshly computed from the deterministic
    // system inputs (principal/rate/dates/basis), NOT from bank-quoted.
    const fetched = await service.getDeposit(baseline.value.record.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok || fetched.value === null) return;
    expect(fetched.value.estimate.grossInterestMinor).toBe(123_288);
    expect(fetched.value.estimate.taxMinor).toBe(24_658);
    expect(fetched.value.estimate.maturityAmountMinor).toBe(10_098_630);
    expect(fetched.value.record.bankQuotedGrossInterestMinor).toBe(9_999_999);
    expect(fetched.value.record.bankQuotedNetInterestMinor).toBe(8_888_888);
  });
});

// ── editable-facts update ──────────────────────────────────────────────────

describe("updateEditableFacts through the service", () => {
  it("patches principal and recomputes the estimate", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const r = await service.updateEditableFacts(created.value.record.id, {
      principalMinor: 20_000_000, // PHP 200,000
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 200,000 * 5% * 90/365 = 2,465.75 centavos == 246_575 centavos
    // tax = round(246_575 * 20%) = 49_315; net = 197_260; maturity = principal + net
    expect(r.value.estimate.grossInterestMinor).toBe(246_575);
    expect(r.value.estimate.maturityAmountMinor).toBe(20_197_260);
  });

  it("rejects patching a certificate with >4 digits", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const r = await service.updateEditableFacts(created.value.record.id, {
      certificateLastFour: "12345",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects patching once the deposit is ACTIVE", async () => {
    const created = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await service.submitForReview(created.value.record.id);
    await service.activate(created.value.record.id);

    const r = await service.updateEditableFacts(created.value.record.id, {
      principalMinor: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ILLEGAL_TRANSITION");
  });
});

// ── predecessor / successor link reads ────────────────────────────────────

describe("predecessor / successor link reads", () => {
  it("getPredecessor / getSuccessor resolve linked deposits", async () => {
    const a = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        productName: "A",
      })
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const b = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
        productName: "B",
        predecessorDepositId: a.value.record.id,
      })
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    const pred = await service.getPredecessor(b.value.record.id);
    expect(pred.ok).toBe(true);
    if (!pred.ok) return;
    expect(pred.value?.id).toBe(a.value.record.id);

    const succ = await service.getSuccessor(a.value.record.id);
    expect(succ.ok).toBe(true);
    if (!succ.ok) return;
    expect(succ.value).toBeNull(); // A does not yet have a successor
  });

  it("getPredecessor returns NOT_FOUND for an unknown deposit id", async () => {
    const r = await service.getPredecessor(999_999);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_FOUND");
  });
});

// ── getDeposit / listDeposits edge cases ───────────────────────────────────

describe("read service edge cases", () => {
  it("getDeposit returns null for an unknown id", async () => {
    const r = await service.getDeposit(999_999);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeNull();
  });

  it("listDeposits returns MEMBER_NOT_FOUND for an unknown holder", async () => {
    const r = await service.listDeposits(999_999);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("listDeposits returns [] for an existing holder with no deposits", async () => {
    const r = await service.listDeposits(seeded.memberId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([]);
  });
});
