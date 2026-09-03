/**
 * Maturity statistics domain types — platform-neutral.
 *
 * Implements SPEC.md §8: deposits maturing in 30/60/90 days with estimated
 * gross/net interest and maturity amount, grouped by currency. Different
 * currencies are NEVER silently summed (SPEC §3 / §8). The deterministic
 * estimate comes from the M1A calculator (`calculateEstimate`), which uses
 * BigInt fixed-point arithmetic — no JavaScript binary floating point.
 *
 * The statistics service builds these objects from term-deposit records +
 * per-currency aggregation; this file only defines the output shape.
 */

/** Per-currency rollup inside a maturity window. */
export interface MaturityWindowCurrencyStats {
  readonly currencyCode: string;
  readonly depositCount: number;
  readonly totalPrincipalMinor: number;
  readonly totalGrossInterestMinor: number;
  readonly totalTaxMinor: number;
  readonly totalNetInterestMinor: number;
  readonly totalMaturityAmountMinor: number;
}

/**
 * Deterministic maturity window statistics. Currency entries are emitted in
 * a stable sort order (currency code ASC) so callers can diff consecutive
 * windows without resorting.
 */
export interface MaturityWindowStats {
  readonly windowDays: number;
  readonly fromDate: string;
  readonly toDate: string;
  readonly byCurrency: readonly MaturityWindowCurrencyStats[];
  /**
   * Total deposit count across all currencies. Present so callers can render
   * "N deposits across M currencies" without summing currency groups.
   */
  readonly totalDepositCount: number;
}

/**
 * Allowed maturity-window sizes. SPEC §8 requires 30/60/90; we model them
 * as the three non-overlapping windows
 *   [today, today+30),   [today+30, today+60),  [today+60, today+90)
 * so a deposit maturing in 45 days appears only in the days60 window.
 */
export const MATURITY_WINDOWS: readonly number[] = [30, 60, 90];

/** Maturity statistics over the three required SPEC §8 windows. */
export interface MaturityAllWindowsStats {
  readonly days30: MaturityWindowStats;
  readonly days60: MaturityWindowStats;
  readonly days90: MaturityWindowStats;
}
