/**
 * Maturity statistics application service.
 *
 * Computes the 30/60/90-day maturity windows per SPEC §8. The computation
 * is deterministic and currency-safe: each currency is aggregated
 * independently, never summed across currencies.
 *
 * Window semantics (non-overlapping):
 *   [today, today+30d)  -> days30
 *   [today+30d, today+60d) -> days60
 *   [today+60d, today+90d) -> days90
 *
 * Only ACTIVE deposits are counted — DRAFT/REVIEW_REQUIRED are not yet
 * locked in, and post-maturity states are no longer "upcoming".
 *
 * The deterministic estimate comes from the M1A calculator (BigInt
 * fixed-point arithmetic). No JavaScript binary floating point is used
 * for money or rate arithmetic.
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
import { ok, type ServiceResult, type TermDepositRecord } from "./types.js";

const MS_PER_DAY = 86_400_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
  totalPrincipalMinor: number;
  totalGrossInterestMinor: number;
  totalTaxMinor: number;
  totalNetInterestMinor: number;
  totalMaturityAmountMinor: number;
}

function aggregateWindow(
  deposits: readonly TermDepositRecord[],
  fromDate: string,
  toDate: string
): {
  byCurrency: readonly MaturityWindowCurrencyStats[];
  totalDepositCount: number;
} {
  const acc = new Map<string, MutableCurrencyAcc>();
  for (const d of deposits) {
    if (!ACTIVE_STATES.includes(d.state)) continue;
    // [fromDate, toDate) — exclusive upper bound so the three windows do
    // not overlap. A deposit maturing exactly on `toDate` belongs to the
    // next window.
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
      totalPrincipalMinor: 0,
      totalGrossInterestMinor: 0,
      totalTaxMinor: 0,
      totalNetInterestMinor: 0,
      totalMaturityAmountMinor: 0,
    };
    row.depositCount += 1;
    row.totalPrincipalMinor += d.principalMinor;
    row.totalGrossInterestMinor += estimate.grossInterestMinor;
    row.totalTaxMinor += estimate.taxMinor;
    row.totalNetInterestMinor += estimate.netInterestMinor;
    row.totalMaturityAmountMinor += estimate.maturityAmountMinor;
    acc.set(d.currencyCode, row);
  }
  const byCurrency: MaturityWindowCurrencyStats[] = Array.from(acc.entries())
    .map(([currencyCode, v]) => ({
      currencyCode,
      depositCount: v.depositCount,
      totalPrincipalMinor: v.totalPrincipalMinor,
      totalGrossInterestMinor: v.totalGrossInterestMinor,
      totalTaxMinor: v.totalTaxMinor,
      totalNetInterestMinor: v.totalNetInterestMinor,
      totalMaturityAmountMinor: v.totalMaturityAmountMinor,
    }))
    // Stable sort: currency code ASC.
    .sort((a, b) => (a.currencyCode < b.currencyCode ? -1 : a.currencyCode > b.currencyCode ? 1 : 0));
  const totalDepositCount = byCurrency.reduce((sum, x) => sum + x.depositCount, 0);
  return { byCurrency, totalDepositCount };
}

export class MaturityStatisticsService {
  constructor(private readonly depositRepo: TermDepositRepository) {}

  /**
   * Compute statistics for a single window [today, today + windowDays).
   *
   * `today` must be a strict ISO 'YYYY-MM-DD' calendar date in UTC.
   * The computation excludes the upper bound, so a deposit maturing
   * exactly 30 days from `today` appears in `days60`, not `days30`.
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
    return ok({
      windowDays,
      fromDate,
      toDate,
      byCurrency: agg.byCurrency,
      totalDepositCount: agg.totalDepositCount,
    });
  }

  /**
   * Compute all three SPEC §8 windows in one call. The result is
   * deterministic: the three windows share the same `today` and the
   * deposit list is fetched once.
   */
  async computeAllWindows(today: string): Promise<ServiceResult<MaturityAllWindowsStats>> {
    const todayCheck = validateToday(today);
    if (todayCheck.ok === false) return todayCheck;
    const fromDate = today;
    const days30ToDate = formatIsoDateUtc(new Date(parseIsoDateUtc(today).getTime() + 30 * MS_PER_DAY));
    const days60ToDate = formatIsoDateUtc(new Date(parseIsoDateUtc(today).getTime() + 60 * MS_PER_DAY));
    const days90ToDate = formatIsoDateUtc(new Date(parseIsoDateUtc(today).getTime() + 90 * MS_PER_DAY));
    const deposits = await this.depositRepo.listAllActiveDeposits();
    const days30Agg = aggregateWindow(deposits, fromDate, days30ToDate);
    const days60Agg = aggregateWindow(deposits, days30ToDate, days60ToDate);
    const days90Agg = aggregateWindow(deposits, days60ToDate, days90ToDate);
    return ok({
      days30: {
        windowDays: 30,
        fromDate,
        toDate: days30ToDate,
        byCurrency: days30Agg.byCurrency,
        totalDepositCount: days30Agg.totalDepositCount,
      },
      days60: {
        windowDays: 60,
        fromDate: days30ToDate,
        toDate: days60ToDate,
        byCurrency: days60Agg.byCurrency,
        totalDepositCount: days60Agg.totalDepositCount,
      },
      days90: {
        windowDays: 90,
        fromDate: days60ToDate,
        toDate: days90ToDate,
        byCurrency: days90Agg.byCurrency,
        totalDepositCount: days90Agg.totalDepositCount,
      },
    });
  }
}

// ── Pure validators ─────────────────────────────────────────────────────────

function validateToday(today: string): ServiceResult<true> {
  if (typeof today !== "string" || !ISO_DATE_PATTERN.test(today)) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "today must be ISO YYYY-MM-DD" },
    };
  }
  parseIsoDateUtc(today);
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
