/**
 * Maturity statistics tests.
 *
 * Covers:
 *   - 30/60/90 day window computation is deterministic
 *   - currency-safe aggregation (different currencies are never summed)
 *   - window boundaries (exclusive upper bound, deposits maturing exactly
 *     on the boundary fall into the next window)
 *   - zero deposits → empty byCurrency, count=0
 *   - deterministic ordering of byCurrency entries
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import {
  D1TermDepositRepository,
  MaturityStatisticsService,
  TermDepositApplicationService,
  type CreateDraftInput,
} from "../../src/services/term-deposit/index.js";
import { seedDepositParents, type SeededParents } from "../_helpers/seed.js";

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
let statsService: MaturityStatisticsService;
let seeded: SeededParents;

beforeEach(async () => {
  db = new FakeD1Database();
  const repo = new D1TermDepositRepository(db);
  service = new TermDepositApplicationService(repo);
  statsService = new MaturityStatisticsService(repo);
  seeded = await seedDepositParents(db);
});

afterEach(() => {
  db.close();
});

async function createActiveDeposit(overrides: Partial<CreateDraftInput> = {}): Promise<number> {
  const r = await service.createDraft(
    VALID_DRAFT({
      accountId: seeded.accountId,
      bankId: seeded.bankId,
      holderMemberId: seeded.memberId,
      ...overrides,
    })
  );
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("seed failed");
  const id = r.value.record.id;
  await service.submitForReview(id);
  await service.activate(id);
  return id;
}

// ── determinism and correctness ────────────────────────────────────────────

describe("computeAllWindows — determinism and correctness", () => {
  it("empty database produces all-zero windows, no currencies", async () => {
    const r = await statsService.computeAllWindows("2026-06-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days30.totalDepositCount).toBe(0);
    expect(r.value.days60.totalDepositCount).toBe(0);
    expect(r.value.days90.totalDepositCount).toBe(0);
    expect(r.value.days30.byCurrency).toEqual([]);
    expect(r.value.days60.byCurrency).toEqual([]);
    expect(r.value.days90.byCurrency).toEqual([]);
  });

  it("deposit maturing in 15 days lands in days30 only", async () => {
    await createActiveDeposit({ maturityDate: "2026-06-16" }); // 15 days after today=2026-06-01
    const r = await statsService.computeAllWindows("2026-06-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days30.totalDepositCount).toBe(1);
    expect(r.value.days60.totalDepositCount).toBe(0);
    expect(r.value.days90.totalDepositCount).toBe(0);
    expect(r.value.days30.byCurrency).toHaveLength(1);
    expect(r.value.days30.byCurrency[0]?.currencyCode).toBe("PHP");
  });

  it("deposit maturing in 45 days lands in days60 only", async () => {
    await createActiveDeposit({ maturityDate: "2026-07-16" }); // 45 days after today
    const r = await statsService.computeAllWindows("2026-06-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days30.totalDepositCount).toBe(0);
    expect(r.value.days60.totalDepositCount).toBe(1);
    expect(r.value.days90.totalDepositCount).toBe(0);
  });

  it("deposit maturing in 75 days lands in days90 only", async () => {
    await createActiveDeposit({ maturityDate: "2026-08-15" }); // 75 days after today
    const r = await statsService.computeAllWindows("2026-06-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days30.totalDepositCount).toBe(0);
    expect(r.value.days60.totalDepositCount).toBe(0);
    expect(r.value.days90.totalDepositCount).toBe(1);
  });

  it("deposit maturing exactly on day-30 boundary lands in days60 (exclusive upper bound)", async () => {
    await createActiveDeposit({ maturityDate: "2026-07-01" }); // exactly 30 days after today=2026-06-01
    const r = await statsService.computeAllWindows("2026-06-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days30.totalDepositCount).toBe(0);
    expect(r.value.days60.totalDepositCount).toBe(1);
  });

  it("deposit maturing exactly on day-60 boundary lands in days90", async () => {
    await createActiveDeposit({ maturityDate: "2026-07-31" }); // exactly 60 days after today=2026-06-01
    const r = await statsService.computeAllWindows("2026-06-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days60.totalDepositCount).toBe(0);
    expect(r.value.days90.totalDepositCount).toBe(1);
  });

  it("deposit maturing exactly 90 days out is excluded", async () => {
    await createActiveDeposit({ maturityDate: "2026-08-30" }); // exactly 90 days after today=2026-06-01
    const r = await statsService.computeAllWindows("2026-06-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days30.totalDepositCount).toBe(0);
    expect(r.value.days60.totalDepositCount).toBe(0);
    expect(r.value.days90.totalDepositCount).toBe(0);
  });

  it("deposit maturing in the past is excluded", async () => {
    await createActiveDeposit({ maturityDate: "2026-05-01" }); // before today
    const r = await statsService.computeAllWindows("2026-06-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days30.totalDepositCount).toBe(0);
    expect(r.value.days60.totalDepositCount).toBe(0);
    expect(r.value.days90.totalDepositCount).toBe(0);
  });
});

// ── currency safety ────────────────────────────────────────────────────────

describe("currency-safe aggregation", () => {
  it("two PHP and one EUR deposit in the same window: each currency is its own entry", async () => {
    await createActiveDeposit({ maturityDate: "2026-06-16", principalMinor: 10_000_000 });
    await createActiveDeposit({ maturityDate: "2026-06-16", principalMinor: 5_000_000 });
    await createActiveDeposit({
      accountId: seeded.accountId2,
      bankId: seeded.otherBankId,
      currencyCode: "EUR",
      maturityDate: "2026-06-16",
      principalMinor: 3_000_000,
    });

    const r = await statsService.computeAllWindows("2026-06-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days30.totalDepositCount).toBe(3);
    expect(r.value.days30.byCurrency).toHaveLength(2);

    const phpEntry = r.value.days30.byCurrency.find((c) => c.currencyCode === "PHP");
    const eurEntry = r.value.days30.byCurrency.find((c) => c.currencyCode === "EUR");
    expect(phpEntry).toBeDefined();
    expect(eurEntry).toBeDefined();
    expect(phpEntry?.depositCount).toBe(2);
    expect(eurEntry?.depositCount).toBe(1);
    // PHP total: 10_000_000 + 5_000_000 = 15_000_000 (no cross-currency math)
    expect(phpEntry?.totalPrincipalMinor).toBe(15_000_000);
    // EUR total stays in EUR minor units; never combined with PHP.
    expect(eurEntry?.totalPrincipalMinor).toBe(3_000_000);

    // byCurrency is sorted by currency code (EUR before PHP).
    expect(r.value.days30.byCurrency[0]?.currencyCode).toBe("EUR");
    expect(r.value.days30.byCurrency[1]?.currencyCode).toBe("PHP");
  });

  it("currency totals are deterministic across calls", async () => {
    await createActiveDeposit({ maturityDate: "2026-06-16", principalMinor: 10_000_000 });
    await createActiveDeposit({
      accountId: seeded.accountId2,
      bankId: seeded.otherBankId,
      currencyCode: "EUR",
      maturityDate: "2026-06-16",
      principalMinor: 3_000_000,
    });

    const a = await statsService.computeAllWindows("2026-06-01");
    const b = await statsService.computeAllWindows("2026-06-01");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.value.days30)).toEqual(JSON.stringify(b.value.days30));
    expect(JSON.stringify(a.value.days60)).toEqual(JSON.stringify(b.value.days60));
    expect(JSON.stringify(a.value.days90)).toEqual(JSON.stringify(b.value.days90));
  });
});

// ── single window compute ─────────────────────────────────────────────────

describe("computeWindow — single window", () => {
  it("a 30-day window returns the same totalDepositCount as days30 in computeAllWindows", async () => {
    await createActiveDeposit({ maturityDate: "2026-06-16" });
    const w = await statsService.computeWindow("2026-06-01", 30);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.value.windowDays).toBe(30);
    expect(w.value.fromDate).toBe("2026-06-01");
    expect(w.value.toDate).toBe("2026-07-01");
    expect(w.value.totalDepositCount).toBe(1);

    const all = await statsService.computeAllWindows("2026-06-01");
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(w.value.totalDepositCount).toBe(all.value.days30.totalDepositCount);
  });

  it("rejects a non-positive windowDays", async () => {
    const r = await statsService.computeWindow("2026-06-01", 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a malformed today", async () => {
    const r = await statsService.computeWindow("06/01/2026", 30);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });
});

// ── SPEC §4.1 regression vector through statistics ────────────────────────

describe("statistics respect the deterministic estimate", () => {
  it("SPEC §4.1 vector: PHP 100,000 / 5% / 90 days / 20% tax aggregates correctly", async () => {
    // Jan 1 -> Apr 1 = 90-day deposit. Pick today = Mar 15 so maturity is
    // 17 days out, comfortably inside the days30 window.
    await createActiveDeposit({
      principalMinor: 10_000_000,
      startDate: "2026-01-01",
      maturityDate: "2026-04-01",
      annualRateScaled: 50_000,
      taxRateScaled: 200_000,
      dayCountBasis: "ACT_365",
    });
    const r = await statsService.computeAllWindows("2026-03-15");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days30.totalDepositCount).toBe(1);
    expect(r.value.days30.byCurrency[0]?.totalGrossInterestMinor).toBe(123_288);
    expect(r.value.days30.byCurrency[0]?.totalTaxMinor).toBe(24_658);
    expect(r.value.days30.byCurrency[0]?.totalNetInterestMinor).toBe(98_630);
    expect(r.value.days30.byCurrency[0]?.totalMaturityAmountMinor).toBe(10_098_630);
  });
});
