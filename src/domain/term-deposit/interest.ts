/**
 * Deterministic term-deposit interest calculation.
 *
 * Platform-neutral domain code: NO Hono, NO D1, NO R2, NO Telegram, NO UI.
 *
 * All financial arithmetic uses BigInt to avoid JavaScript binary floating-point
 * precision loss. Inputs are validated as integers; the rounding rule is
 * round-half-away-from-zero (also called "round-half-up" for non-negative
 * values, which covers every deposit-related calculation in this domain).
 *
 * SPEC.md §4.1 defines the exact contract and the required regression vectors.
 *
 * COMPOUND interest is not implemented: SPEC.md does not specify a
 * compounding-frequency contract, and guessing one would silently change
 * money. `calculateEstimate` therefore throws an explicit blocker when the
 * input requests COMPOUND.
 */

import {
  RATE_SCALE,
  MAX_ANNUAL_RATE_SCALED,
  MAX_TAX_RATE_SCALED,
  type DayCountBasis,
  type InterestMethod,
} from "./types.js";

/** Inputs for an interest estimate. All numeric fields are integers. */
export interface InterestInputs {
  readonly principalMinor: number;
  readonly annualRateScaled: number;
  readonly taxRateScaled: number;
  readonly feesMinor: number;
  readonly startDate: string;
  readonly maturityDate: string;
  readonly interestMethod: InterestMethod;
  readonly dayCountBasis: DayCountBasis;
}

/** Result of a deterministic term-deposit interest estimate. */
export interface InterestEstimate {
  readonly grossInterestMinor: number;
  readonly taxMinor: number;
  readonly netInterestMinor: number;
  readonly maturityAmountMinor: number;
}

/** Result of the day-count helper. */
export interface DayCountResult {
  readonly days: number;
  readonly basisDays: number;
}

const MS_PER_DAY = 86_400_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a 'YYYY-MM-DD' date as UTC midnight. Throws on malformed input.
 * No timezone ambiguity: dates are stored as ISO strings and treated as UTC.
 */
function parseIsoDateUtc(s: string): Date {
  if (typeof s !== "string" || !ISO_DATE_PATTERN.test(s)) {
    throw new Error(`Invalid ISO date (expected YYYY-MM-DD): ${s}`);
  }
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${s}`);
  }
  return parsed;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * ACT_ACT reporting helper: returns the divisor for the start year.
 * Financial calculation does not rely on this single divisor for cross-year
 * deposits; computeSimpleGrossMinor splits those intervals by calendar year.
 */
export function dayCountBetween(
  startDate: string,
  maturityDate: string,
  basis: DayCountBasis
): DayCountResult {
  const start = parseIsoDateUtc(startDate);
  const end = parseIsoDateUtc(maturityDate);
  const rawDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
  if (rawDays < 0) {
    throw new Error(`Maturity date ${maturityDate} is before start date ${startDate}`);
  }
  let basisDays: number;
  switch (basis) {
    case "ACT_365":
      basisDays = 365;
      break;
    case "ACT_360":
      basisDays = 360;
      break;
    case "ACT_ACT":
      basisDays = isLeapYear(start.getUTCFullYear()) ? 366 : 365;
      break;
  }
  return { days: rawDays, basisDays };
}

/**
 * Round-half-away-from-zero on a positive BigInt ratio.
 *
 *   round(n / d) = floor((n + d/2) / d)         for n >= 0
 *   round(n / d) = -floor((-n + d/2) / d)      for n < 0
 *
 * Used internally; not exported because the public API takes validated integers.
 */
function roundHalfAway(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("roundHalfAway: denominator must be positive");
  }
  const half = denominator / 2n;
  if (numerator >= 0n) {
    return (numerator + half) / denominator;
  }
  // For negative ratios: round(-x) = -round(x).
  return -((-numerator + half) / denominator);
}

function validateIntegerField(name: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer: ${value}`);
  }
}

/**
 * Compute the gross interest for a SIMPLE-interest deposit using integer-only
 * fixed-point arithmetic. Returns a BigInt in minor units.
 *
 *   gross = principal × rate_scaled × days / (RATE_SCALE × basis_days)
 *
 * Rounded half-away-from-zero to the minor unit. All intermediate values stay
 * in BigInt so no binary floating-point path is taken.
 */
function computeSimpleGrossMinor(inputs: InterestInputs): bigint {
  const start = parseIsoDateUtc(inputs.startDate);
  const end = parseIsoDateUtc(inputs.maturityDate);
  if (end.getTime() < start.getTime()) {
    throw new Error(\n      `Maturity date ${inputs.maturityDate} is before start date ${inputs.startDate}`\n    );
  }

  const principal = BigInt(inputs.principalMinor);
  const rate = BigInt(inputs.annualRateScaled);
  const scale = BigInt(RATE_SCALE);

  if (inputs.dayCountBasis !== "ACT_ACT") {
    const dc = dayCountBetween(inputs.startDate, inputs.maturityDate, inputs.dayCountBasis);
    return roundHalfAway(principal * rate * BigInt(dc.days), scale * BigInt(dc.basisDays));
  }

  // ISDA-style ACT/ACT: split the actual interval at calendar-year boundaries,
  // then sum each segment over that year's actual 365/366-day denominator.
  // 365*366 is a common denominator, so the financial path remains integer-only
  // and the final result is rounded exactly once.
  let cursor = start;
  let daysIn365Years = 0n;
  let daysIn366Years = 0n;
  while (cursor.getTime() < end.getTime()) {
    const year = cursor.getUTCFullYear();
    const nextYear = new Date(Date.UTC(year + 1, 0, 1));
    const segmentEnd = nextYear.getTime() < end.getTime() ? nextYear : end;
    const segmentDays = BigInt(
      Math.round((segmentEnd.getTime() - cursor.getTime()) / MS_PER_DAY)
    );
    if (isLeapYear(year)) {
      daysIn366Years += segmentDays;
    } else {
      daysIn365Years += segmentDays;
    }
    cursor = segmentEnd;
  }

  const commonYearDenominator = 365n * 366n;
  const weightedDays = daysIn365Years * 366n + daysIn366Years * 365n;
  return roundHalfAway(principal * rate * weightedDays, scale * commonYearDenominator);
}

/**
 * Compute the tax amount from gross interest and a tax rate using integer-only
 * fixed-point arithmetic. Returns a BigInt in minor units.
 *
 *   tax = round(gross × tax_rate_scaled / RATE_SCALE)
 */
function computeTaxMinor(grossMinor: bigint, taxRateScaled: number): bigint {
  const rate = BigInt(taxRateScaled);
  const scale = BigInt(RATE_SCALE);
  return roundHalfAway(grossMinor * rate, scale);
}

/**
 * Deterministic SIMPLE-interest estimate.
 *
 * Steps (all BigInt arithmetic, no binary float):
 *   1. gross = round( principal × rate × days / (RATE_SCALE × basis) )
 *   2. tax   = round( gross × tax_rate / RATE_SCALE )
 *   3. net   = gross - tax
 *   4. maturity = principal + net - fees
 *
 * Throws on any invalid (non-integer, negative, out-of-range) input or on a
 * maturity date earlier than the start date.
 */
export function calculateSimpleInterest(inputs: InterestInputs): InterestEstimate {
  validateInputs(inputs);

  // Validate maturity not before start (re-raises inside dayCountBetween).
  dayCountBetween(inputs.startDate, inputs.maturityDate, inputs.dayCountBasis);

  const gross = computeSimpleGrossMinor(inputs);
  const tax = computeTaxMinor(gross, inputs.taxRateScaled);
  const net = gross - tax;
  const principal = BigInt(inputs.principalMinor);
  const fees = BigInt(inputs.feesMinor);
  const maturity = principal + net - fees;

  return {
    grossInterestMinor: numberFromBigInt("grossInterestMinor", gross),
    taxMinor: numberFromBigInt("taxMinor", tax),
    netInterestMinor: numberFromBigInt("netInterestMinor", net),
    maturityAmountMinor: numberFromBigInt("maturityAmountMinor", maturity),
  };
}

/**
 * Top-level estimate dispatcher.
 *
 * SIMPLE -> calculateSimpleInterest
 * COMPOUND -> throws an explicit blocker (see file header).
 *
 * Unknown interest methods are rejected. The function never silently guesses.
 */
export function calculateEstimate(inputs: InterestInputs): InterestEstimate {
  switch (inputs.interestMethod) {
    case "SIMPLE":
      return calculateSimpleInterest(inputs);
    case "COMPOUND":
      throw new Error(
        "COMPOUND interest calculation requires a compounding-frequency contract " +
          "that is not specified in SPEC.md. Treat as a blocker; do not silently guess."
      );
  }
}

function validateInputs(inputs: InterestInputs): void {
  validateIntegerField("principalMinor", inputs.principalMinor);
  if (inputs.principalMinor < 0) {
    throw new Error(`principalMinor must be >= 0: ${inputs.principalMinor}`);
  }
  validateIntegerField("annualRateScaled", inputs.annualRateScaled);
  if (inputs.annualRateScaled < 0) {
    throw new Error(`annualRateScaled must be >= 0: ${inputs.annualRateScaled}`);
  }
  if (inputs.annualRateScaled > MAX_ANNUAL_RATE_SCALED) {
    throw new Error(
      `annualRateScaled exceeds sanity ceiling: ${inputs.annualRateScaled} > ${MAX_ANNUAL_RATE_SCALED}`
    );
  }
  validateIntegerField("taxRateScaled", inputs.taxRateScaled);
  if (inputs.taxRateScaled < 0) {
    throw new Error(`taxRateScaled must be >= 0: ${inputs.taxRateScaled}`);
  }
  if (inputs.taxRateScaled > MAX_TAX_RATE_SCALED) {
    throw new Error(`taxRateScaled exceeds 100%: ${inputs.taxRateScaled}`);
  }
  validateIntegerField("feesMinor", inputs.feesMinor);
  if (inputs.feesMinor < 0) {
    throw new Error(`feesMinor must be >= 0: ${inputs.feesMinor}`);
  }
}

function numberFromBigInt(name: string, value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} exceeds Number.MAX_SAFE_INTEGER: ${value.toString()}`);
  }
  return Number(value);
}
