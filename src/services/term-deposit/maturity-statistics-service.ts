/**
 * Maturity statistics application service.
 *
 * Computes the 30/60/90-day maturity horizons per SPEC §8. The computation
 * is deterministic and currency-safe: each currency is aggregated
 * independently, never summed across currencies.
 *
 * Window semantics (cumulative horizons from `today`, exclusive upper bound):
 *   [today, today+30d)  -> days30
 *   [today, today+60d)  -> days60  (includes everything in days30)
 *   [today, today+90d)  -> days90  (includes everything in days60)
 *
 * A deposit maturing exactly on an upper bound (e.g. today+30d, today+60d)
 * falls outside that horizon. The three horizons are cumulative so the
 * dashboard can render "maturing in the next 30 / 60 / 90 days" without
 * double-counting; a deposit at 45 days appears in both days60 and days90.
 *
 * Only ACTIVE deposits are counted — DRAFT/REVIEW_REQUIRED are not yet
 * locked in, and post-maturity states are no longer "upcoming".
 *
 * The deterministic estimate comes from the M1A calculator (BigInt
 * fixed-point arithmetic). Aggregation uses bigint internally to avoid
 * JavaScript `number` overflow when several deposits each close to
 * Number.MAX_SAFE_INTEGER are summed; a typed `OVERFLOW` failure is
 * returned if a per-currency total cannot be represented safely.
 */

import {
  calculateEstimate,
  type InterestEstimate,
  type TermDepositState,
} from "../../domain/term-deposit/index.js";
import type {
  MaturityAllWindowsStats,
  MaturityWindowCurrencyStats,
  MaturityWindowStats,
} from "../../domain/term-deposit/index.js";
import type { TermDepositRepository } from "./repository.js";
import { fail, ok, type ServiceResult, type TermDepositRecord } from "./types.js";

const MS_PER_DAY = 86_400_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER_MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

const ACTIVE_STATES: readonly TermDepositState[] = ["ACTIVE"];

function parseIsoDateUtc(s: string): Date {
  if (typeof s !== "string" || !ISO_DATE_PATTERN.test(s)) {
    throw new Error(`Invalid ISO date (expected YYYY-MM-DD): ${s}`);
  }
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`Invalid calendar date: ${s}`);
  }
  return parsed;
}

function formatIsoDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface MutableCurrencyAcc {
  depositCount: number;
  totalPrincipalMinor: bigint;
  totalGrossInterestMinor: bigint;
  totalTaxMinor: bigint;
  totalNetInterestMinor: bigint;
  totalMaturityAmountMinor: bigint;
}

/**
 * Bigint-safe monetary total. If the per-currency sum exceeds
 * Number.MAX_SAFE_INTEGER, the conversion to `number` would silently
 * corrupt the value. Callers must check the returned boolean before
 * using the numeric representation. This is a range check, not a type
 * guard: the argument is always a bigint.
 */
function isSafeNumberRange(n: bigint): boolean {
  return n >= -NUMBER_MAX_SAFE_INTEGER && n <= NUMBER_MAX_SAFE_INTEGER;
}

type WindowAggregate = {
  byCurrency: readonly MaturityWindowCurrencyStats[];
  totalDepositCount: number;
};

/**
 * Aggregate deposits into per-currency totals for a single horizon
 * [fromDate, toDate). Uses bigint accumulation internally and returns a
 * typed OVERFLOW failure if any per-currency total exceeds
 * Number.MAX_SAFE_INTEGER — the safe boundary established by the M1A
 * calculator for minor-unit arithmetic.
 */
function aggregateWindow(
  deposits: readonly TermDepositRecord[],
  fromDate: string,
  toDate: string
): ServiceResult<WindowAggregate> {
  const acc = new Map<string, MutableCurrencyAcc>();
  for (const d of deposits) {
    if (!ACTIVE_STATES.includes(d.state)) continue;
    // [fromDate, toDate) — exclusive upper bound so the horizons never
    // include the boundary day in the shorter horizon (e.g. day+30
    // belongs to days60, not days30).
    if (d.maturityDate < fromDate || d.maturityDate >= toDate) continue;
    let estimate: InterestEstimate;
    try {
      estimate = calculateEstimate({
        principalMinor: d.principalMinor,
        annualRateScaled: d.annualRateScaled,
        taxRateScaled: d.taxRateScaled,
        feesMinor: d.feesMinor,
        startDate: d.startDate,
        maturityDate: d.maturityDate,
        interestMethod: d.interestMethod,
        dayCountBasis: d.dayCountBasis,
      });
    } catch {
      // A corrupted stored record (e.g. unsafe integer) is silently
      // excluded from statistics — the same "don't break the dashboard"
      // stance the term-deposit service uses. A separate diagnostics
      // slice can surface these rows.
      continue;
    }
    const row = acc.get(d.currencyCode) ?? {
      depositCount: 0,
      totalPrincipalMinor: 0n,
      totalGrossInterestMinor: 0n,
      totalTaxMinor: 0n,
      totalNetInterestMinor: 0n,
      totalMaturityAmountMinor: 0n,
    };
    row.depositCount += 1;
    row.totalPrincipalMinor += BigInt(d.principalMinor);
    row.totalGrossInterestMinor += BigInt(estimate.grossInterestMinor);
    row.totalTaxMinor += BigInt(estimate.taxMinor);
    row.totalNetInterestMinor += BigInt(estimate.netInterestMinor);
    row.totalMaturityAmountMinor += BigInt(estimate.maturityAmountMinor);
    acc.set(d.currencyCode, row);
  }
  const byCurrency: MaturityWindowCurrencyStats[] = [];
  for (const [currencyCode, v] of acc.entries()) {
    if (
      !isSafeNumberRange(v.totalPrincipalMinor) ||
      !isSafeNumberRange(v.totalGrossInterestMinor) ||
      !isSafeNumberRange(v.totalTaxMinor) ||
      !isSafeNumberRange(v.totalNetInterestMinor) ||
      !isSafeNumberRange(v.totalMaturityAmountMinor)
    ) {
      return fail(
        "OVERFLOW",
        `Currency total for ${currencyCode} exceeds Number.MAX_SAFE_INTEGER; aggregation is not safe to represent in JavaScript number`
      );
    }
    byCurrency.push({
      currencyCode,
      depositCount: v.depositCount,
      totalPrincipalMinor: Number(v.totalPrincipalMinor),
      totalGrossInterestMinor: Number(v.totalGrossInterestMinor),
      totalTaxMinor: Number(v.totalTaxMinor),
      totalNetInterestMinor: Number(v.totalNetInterestMinor),
      totalMaturityAmountMinor: Number(v.totalMaturityAmountMinor),
    });
  }
  // Stable sort: currency code ASC.
  byCurrency.sort((a, b) => (a.currencyCode < b.currencyCode ? -1 : a.currencyCode > b.currencyCode ? 1 : 0));
  const totalDepositCount = byCurrency.reduce((sum, x) => sum + x.depositCount, 0);
  return ok({ byCurrency, totalDepositCount });
}

export class MaturityStatisticsService {
  constructor(private readonly depositRepo: TermDepositRepository) {}

  /**
   * Compute statistics for a single horizon [today, today + windowDays).
   *
   * `today` must be a strict ISO 'YYYY-MM-DD' calendar date in UTC.
   * The computation excludes the upper bound, so a deposit maturing
   * exactly windowDays from `today` does NOT appear in the result.
   *
   * The output groups deposits by currency. Different currencies are
   * never summed 1:1 (SPEC §3 / §8).
   */
  async computeWindow(today: string, windowDays: number): Promise<ServiceResult<MaturityWindowStats>> {
    const windowCheck = validateWindow(today, windowDays);
    if (windowCheck.ok === false) return windowCheck;
    const fromDate = today;
    const toDate = formatIsoDateUtc(new Date(parseIsoDateUtc(today).getTime() + windowDays * MS_PER_DAY));
    const deposits = await this.depositRepo.listAllActiveDeposits();
    const agg = aggregateWindow(deposits, fromDate, toDate);
    if (agg.ok === false) return agg;
    return ok({
      windowDays,
      fromDate,
      toDate,
      byCurrency: agg.value.byCurrency,
      totalDepositCount: agg.value.totalDepositCount,
    });
  }

  /**
   * Compute all three SPEC §8 horizons in one call. The horizons are
   * CUMULATIVE from `today`:
   *   days30 = [today, today+30d)
   *   days60 = [today, today+60d)  (includes everything in days30)
   *   days90 = [today, today+90d)  (includes everything in days60)
   *
   * This matches the SPEC §8 "30/60/90 maturity calendar/timeline" so
   * the dashboard can render cumulative upcoming maturity exposure.
   * A deposit maturing at 45 days appears in both days60 and days90.
   *
   * The result is deterministic: the three horizons share the same
   * `today` and the deposit list is fetched once.
   */
  async computeAllWindows(today: string): Promise<ServiceResult<MaturityAllWindowsStats>> {
    const todayCheck = validateToday(today);
    if (todayCheck.ok === false) return todayCheck;
    const fromDate = today;
    const days30ToDate = formatIsoDateUtc(new Date(parseIsoDateUtc(today).getTime() + 30 * MS_PER_DAY));
    const days60ToDate = formatIsoDateUtc(new Date(parseIsoDateUtc(today).getTime() + 60 * MS_PER_DAY));
    const days90ToDate = formatIsoDateUtc(new Date(parseIsoDateUtc(today).getTime() + 90 * MS_PER_DAY));
    const deposits = await this.depositRepo.listAllActiveDeposits();
    // days30: [today, today+30d)
    const days30Agg = aggregateWindow(deposits, fromDate, days30ToDate);
    if (days30Agg.ok === false) return days30Agg;
    // days60: [today, today+60d) — cumulative, includes days30 contents.
    const days60Agg = aggregateWindow(deposits, fromDate, days60ToDate);
    if (days60Agg.ok === false) return days60Agg;
    // days90: [today, today+90d) — cumulative, includes days60 contents.
    const days90Agg = aggregateWindow(deposits, fromDate, days90ToDate);
    if (days90Agg.ok === false) return days90Agg;
    return ok({
      days30: {
        windowDays: 30,
        fromDate,
        toDate: days30ToDate,
        byCurrency: days30Agg.value.byCurrency,
        totalDepositCount: days30Agg.value.totalDepositCount,
      },
      days60: {
        windowDays: 60,
        fromDate,
        toDate: days60ToDate,
        byCurrency: days60Agg.value.byCurrency,
        totalDepositCount: days60Agg.value.totalDepositCount,
      },
      days90: {
        windowDays: 90,
        fromDate,
        toDate: days90ToDate,
        byCurrency: days90Agg.value.byCurrency,
        totalDepositCount: days90Agg.value.totalDepositCount,
      },
    });
  }
}

// ── Pure validators ─────────────────────────────────────────────────────────

/**
 * Strict external-date validation for `today`. The regex only proves the
 * layout, so the value must also round-trip through `Date.UTC` to reject
 * impossible calendar days such as `2026-02-30` or `2026-99-99`. The
 * service boundary never throws: a bad input becomes a typed
 * INVALID_INPUT failure.
 */
function validateToday(today: string): ServiceResult<true> {
  if (typeof today !== "string" || !ISO_DATE_PATTERN.test(today)) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "today must be ISO YYYY-MM-DD" },
    };
  }
  try {
    parseIsoDateUtc(today);
  } catch {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `today must be a real UTC calendar date: ${today}`,
      },
    };
  }
  return { ok: true, value: true };
}

function validateWindow(today: string, windowDays: number): ServiceResult<true> {
  const t = validateToday(today);
  if (t.ok === false) return t;
  if (!Number.isSafeInteger(windowDays) || windowDays <= 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "windowDays must be a positive safe integer",
      },
    };
  }
  return { ok: true, value: true };
}
