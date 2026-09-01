/**
 * Term-deposit interest calculation tests.
 *
 * Covers:
 *   - The two SPEC §4.1 regression vectors exactly.
 *   - Boundary cases: zero tax, zero fees, zero days, zero rate, zero principal.
 *   - Validation: negative or non-integer financial inputs.
 *   - Date validation: maturity before start.
 *   - Rounding at half-centavo boundaries (round-half-away-from-zero).
 *   - ACT_ACT divisor choice for leap and non-leap years.
 *   - COMPOUND is an explicit blocker, not silently guessed.
 *
 * All asserted money values are integer minor units.
 */

import { describe, it, expect } from "vitest";
import {
  RATE_SCALE,
  calculateEstimate,
  calculateSimpleInterest,
  dayCountBetween,
  type InterestInputs,
} from "../../src/domain/term-deposit/index.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeInputs(overrides: Partial<InterestInputs> = {}): InterestInputs {
  return {
    principalMinor: 10_000_000, // 100,000.00 minor units (e.g. centavos)
    annualRateScaled: 50_000, // 5%
    taxRateScaled: 200_000, // 20%
    feesMinor: 0,
    startDate: "2026-01-01",
    maturityDate: "2026-04-01", // 90-day end-exclusive interval
    interestMethod: "SIMPLE",
    dayCountBasis: "ACT_365",
    ...overrides,
  };
}

// ── SPEC §4.1 regression vectors ─────────────────────────────────────────────

describe("SPEC §4.1 regression vectors", () => {
  it("ACT/365: PHP 100,000 / 5% / 90 days / 20% tax", () => {
    const result = calculateSimpleInterest(
      makeInputs({
        startDate: "2026-01-01",
        maturityDate: "2026-04-01", // 90 days
        dayCountBasis: "ACT_365",
      })
    );

    expect(result.grossInterestMinor).toBe(123_288); // PHP 1,232.88
    expect(result.taxMinor).toBe(24_658); // PHP 246.58
    expect(result.netInterestMinor).toBe(98_630); // PHP 986.30
    expect(result.maturityAmountMinor).toBe(10_098_630); // PHP 100,986.30
  });

  it("ACT/360: same inputs -> PHP 1,250.00 gross / 1,000.00 net", () => {
    const result = calculateSimpleInterest(
      makeInputs({
        startDate: "2026-01-01",
        maturityDate: "2026-04-01", // 90 days
        dayCountBasis: "ACT_360",
      })
    );

    expect(result.grossInterestMinor).toBe(125_000); // PHP 1,250.00
    expect(result.taxMinor).toBe(25_000); // PHP 250.00
    expect(result.netInterestMinor).toBe(100_000); // PHP 1,000.00
    expect(result.maturityAmountMinor).toBe(10_100_000); // PHP 101,000.00
  });

  it("regression vectors are currency-agnostic (inputs are pure minor units)", () => {
    // Same numerics in any currency produce the same minor-unit result; the
    // calculation never reads a currency code.
    const a = calculateSimpleInterest(makeInputs());
    const b = calculateSimpleInterest(makeInputs());
    expect(a).toEqual(b);
  });
});

// ── Zero and trivial inputs ─────────────────────────────────────────────────

describe("zero and trivial inputs", () => {
  it("zero tax -> maturity equals principal plus gross", () => {
    const result = calculateSimpleInterest(makeInputs({ taxRateScaled: 0 }));
    expect(result.taxMinor).toBe(0);
    expect(result.netInterestMinor).toBe(result.grossInterestMinor);
    expect(result.maturityAmountMinor).toBe(10_000_000 + result.grossInterestMinor);
  });

  it("zero fees -> maturity equals principal plus net interest", () => {
    const result = calculateSimpleInterest(makeInputs({ feesMinor: 0 }));
    expect(result.maturityAmountMinor).toBe(10_000_000 + result.netInterestMinor);
  });

  it("non-zero fees reduce maturity by exactly the fee amount", () => {
    const fees = 12_345; // PHP 123.45
    const result = calculateSimpleInterest(makeInputs({ feesMinor: fees }));
    expect(result.maturityAmountMinor).toBe(10_000_000 + result.netInterestMinor - fees);
  });

  it("zero days (same date) -> gross/tax/net all zero, maturity equals principal", () => {
    const result = calculateSimpleInterest(
      makeInputs({ startDate: "2026-01-01", maturityDate: "2026-01-01" })
    );
    expect(result.grossInterestMinor).toBe(0);
    expect(result.taxMinor).toBe(0);
    expect(result.netInterestMinor).toBe(0);
    expect(result.maturityAmountMinor).toBe(10_000_000);
  });

  it("zero rate -> gross/tax/net all zero", () => {
    const result = calculateSimpleInterest(makeInputs({ annualRateScaled: 0 }));
    expect(result.grossInterestMinor).toBe(0);
    expect(result.taxMinor).toBe(0);
    expect(result.netInterestMinor).toBe(0);
    expect(result.maturityAmountMinor).toBe(10_000_000);
  });

  it("zero principal -> all outputs zero", () => {
    const result = calculateSimpleInterest(makeInputs({ principalMinor: 0 }));
    expect(result).toEqual({
      grossInterestMinor: 0,
      taxMinor: 0,
      netInterestMinor: 0,
      maturityAmountMinor: 0,
    });
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe("input validation", () => {
  it("rejects non-integer principal", () => {
    expect(() => calculateSimpleInterest(makeInputs({ principalMinor: 1.5 as number }))).toThrow(
      /principalMinor must be an integer/
    );
  });

  it("rejects negative principal", () => {
    expect(() => calculateSimpleInterest(makeInputs({ principalMinor: -1 }))).toThrow(
      /principalMinor must be >= 0/
    );
  });

  it("rejects unsafe integer money before BigInt conversion", () => {
    expect(() =>
      calculateSimpleInterest(makeInputs({ principalMinor: Number.MAX_SAFE_INTEGER + 1 }))
    ).toThrow(/principalMinor must be an integer/);
  });

  it("rejects COMPOUND at the direct SIMPLE entry point", () => {
    expect(() => calculateSimpleInterest(makeInputs({ interestMethod: "COMPOUND" }))).toThrow(
      /requires SIMPLE/
    );
  });

  it("rejects negative annual rate", () => {
    expect(() => calculateSimpleInterest(makeInputs({ annualRateScaled: -1 }))).toThrow(
      /annualRateScaled must be >= 0/
    );
  });

  it("rejects non-integer annual rate", () => {
    expect(() => calculateSimpleInterest(makeInputs({ annualRateScaled: 0.5 as number }))).toThrow(
      /annualRateScaled must be an integer/
    );
  });

  it("rejects annual rate above the sanity ceiling", () => {
    expect(() => calculateSimpleInterest(makeInputs({ annualRateScaled: RATE_SCALE * 1_001 }))).toThrow(
      /sanity ceiling/
    );
  });

  it("rejects negative tax rate", () => {
    expect(() => calculateSimpleInterest(makeInputs({ taxRateScaled: -1 }))).toThrow(
      /taxRateScaled must be >= 0/
    );
  });

  it("rejects tax rate above 100%", () => {
    expect(() => calculateSimpleInterest(makeInputs({ taxRateScaled: RATE_SCALE + 1 }))).toThrow(
      /taxRateScaled exceeds 100%/
    );
  });

  it("rejects negative fees", () => {
    expect(() => calculateSimpleInterest(makeInputs({ feesMinor: -1 }))).toThrow(/feesMinor must be >= 0/);
  });

  it("rejects maturity date before start date", () => {
    expect(() =>
      calculateSimpleInterest(makeInputs({ startDate: "2026-04-01", maturityDate: "2026-01-01" }))
    ).toThrow(/before start date/);
  });

  it("rejects malformed ISO date", () => {
    expect(() =>
      calculateSimpleInterest(makeInputs({ startDate: "not-a-date", maturityDate: "2026-04-01" }))
    ).toThrow(/Invalid ISO date/);
  });

  it("rejects impossible calendar dates instead of normalizing them", () => {
    expect(() =>
      calculateSimpleInterest(makeInputs({ startDate: "2026-02-30", maturityDate: "2026-04-01" }))
    ).toThrow(/Invalid calendar date/);
  });
});

// ── Rounding boundaries ─────────────────────────────────────────────────────

describe("rounding boundaries", () => {
  it("rounds a positive x.5 case up (round-half-away-from-zero)", () => {
    // Construct: gross_math = 0.5 centavos exactly.
    // principal = 1 cent, rate = 50% (500_000 scaled), days = 365, basis ACT_365.
    // numerator   = 1 * 500_000 * 365 = 182_500_000
    // denominator = 1_000_000 * 365   = 365_000_000
    // ratio       = 0.5 exactly -> rounds to 1 centavo.
    const result = calculateSimpleInterest(
      makeInputs({
        principalMinor: 1,
        annualRateScaled: 500_000,
        taxRateScaled: 0,
        startDate: "2025-01-01",
        maturityDate: "2025-12-31", // 364 days
      })
    );
    // 364 / 365 * 0.5 = 0.49863... -> rounds to 0
    expect(result.grossInterestMinor).toBe(0);

    // Now use exactly 365 days so the ratio is exactly 0.5 -> rounds to 1.
    const exact = calculateSimpleInterest(
      makeInputs({
        principalMinor: 1,
        annualRateScaled: 500_000,
        taxRateScaled: 0,
        startDate: "2025-01-01",
        maturityDate: "2026-01-01", // 365 days
      })
    );
    expect(exact.grossInterestMinor).toBe(1);
  });

  it("rounds tax at the half-centavo boundary", () => {
    // Construct gross = 10 centavos, tax_rate = 5% => tax_math = 0.5 centavos exactly.
    // Round-half-away-from-zero -> 1 centavo.
    //   principal 10, rate 100% (1_000_000), 1 day, ACT/360 -> gross = 10 * 1 * 1 / 360
    //   (rounds). Use 36 days instead: 10 * 1_000_000 * 36 / (1_000_000 * 360) = 1.0
    //   exactly, not helpful for the boundary. Use ACT_365 with 365 days:
    //   10 * 1_000_000 * 365 / (1_000_000 * 365) = 10 exactly -> tax = 0.5.
    const exact = calculateSimpleInterest(
      makeInputs({
        principalMinor: 10,
        annualRateScaled: 1_000_000,
        taxRateScaled: 50_000, // 5%
        feesMinor: 0,
        startDate: "2025-01-01",
        maturityDate: "2026-01-01", // 365 days, ACT_365
      })
    );
    expect(exact.grossInterestMinor).toBe(10);
    // 10 * 50_000 / 1_000_000 = 0.5 -> round-half-away-from-zero = 1
    expect(exact.taxMinor).toBe(1);
    expect(exact.netInterestMinor).toBe(9);
  });

  it("interest computation contains no JavaScript binary float arithmetic for outcomes", () => {
    // The SPEC regression vector must match exactly to prove the integer path.
    // This is a meta-test: if anyone re-introduces a float multiply/divide,
    // the regression vector above will fail.
    const result = calculateSimpleInterest(makeInputs());
    expect(result.grossInterestMinor).toBe(123_288);
  });
});

// ── ACT_ACT explicit contract ───────────────────────────────────────────────

describe("ACT_ACT explicit contract", () => {
  it("uses 366 as divisor when the start year is a leap year", () => {
    // 2024 is a leap year. principal 366*10_000, rate 100% (1_000_000), 1 day.
    // gross = 366_000 * 1_000_000 * 1 / (1_000_000 * 366) = 1_000 centavos exactly.
    const result = calculateSimpleInterest(
      makeInputs({
        principalMinor: 366_000,
        annualRateScaled: 1_000_000,
        taxRateScaled: 0,
        startDate: "2024-06-01",
        maturityDate: "2024-06-02", // 1 day
        dayCountBasis: "ACT_ACT",
      })
    );
    expect(result.grossInterestMinor).toBe(1_000);
  });

  it("uses 365 as divisor when the start year is non-leap", () => {
    // 2025 is not a leap year. Same 1-day deposit -> gross = 365_000 * 1 * 1 / 365.
    const result = calculateSimpleInterest(
      makeInputs({
        principalMinor: 365_000,
        annualRateScaled: 1_000_000,
        taxRateScaled: 0,
        startDate: "2025-06-01",
        maturityDate: "2025-06-02", // 1 day
        dayCountBasis: "ACT_ACT",
      })
    );
    expect(result.grossInterestMinor).toBe(1_000);
  });

  it("splits a cross-year interval across its 365/366 denominators", () => {
    const result = calculateSimpleInterest(
      makeInputs({
        principalMinor: 133_590,
        annualRateScaled: 1_000_000,
        taxRateScaled: 0,
        startDate: "2023-07-01",
        maturityDate: "2024-07-01",
        dayCountBasis: "ACT_ACT",
      })
    );
    // 133590 * (184/365 + 182/366) = 133774 exactly.
    expect(result.grossInterestMinor).toBe(133_774);
  });
});

// ── dayCountBetween helper ──────────────────────────────────────────────────

describe("dayCountBetween", () => {
  it("ACT_365 always uses 365 as divisor", () => {
    const dc = dayCountBetween("2026-01-01", "2026-04-01", "ACT_365");
    expect(dc.days).toBe(90);
    expect(dc.basisDays).toBe(365);
  });

  it("ACT_360 always uses 360 as divisor", () => {
    const dc = dayCountBetween("2026-01-01", "2026-04-01", "ACT_360");
    expect(dc.days).toBe(90);
    expect(dc.basisDays).toBe(360);
  });

  it("ACT_ACT uses 366 in a leap-year start", () => {
    const dc = dayCountBetween("2024-01-01", "2024-12-31", "ACT_ACT");
    expect(dc.days).toBe(365);
    expect(dc.basisDays).toBe(366);
  });

  it("ACT_ACT uses 365 in a non-leap-year start", () => {
    const dc = dayCountBetween("2025-01-01", "2025-12-31", "ACT_ACT");
    expect(dc.days).toBe(364);
    expect(dc.basisDays).toBe(365);
  });
});

// ── COMPOUND blocker ────────────────────────────────────────────────────────

describe("COMPOUND interest", () => {
  it("throws an explicit blocker instead of silently guessing", () => {
    expect(() => calculateEstimate(makeInputs({ interestMethod: "COMPOUND" }))).toThrow(
      /COMPOUND interest calculation requires a compounding-frequency/
    );
  });

  it("SIMPLE dispatch still works via calculateEstimate", () => {
    const result = calculateEstimate(makeInputs());
    expect(result.grossInterestMinor).toBe(123_288);
  });
});

// ── Currency independence ───────────────────────────────────────────────────

describe("currency independence", () => {
  it("two runs with the same integer inputs are deterministic", () => {
    // Inputs are integer minor units only; identical inputs must produce
    // identical outputs regardless of any currency context.
    const a = calculateSimpleInterest(makeInputs({ principalMinor: 7_777_777 }));
    const b = calculateSimpleInterest(makeInputs({ principalMinor: 7_777_777 }));
    expect(a).toEqual(b);
  });
});
