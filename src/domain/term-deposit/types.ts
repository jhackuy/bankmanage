/**
 * Term-deposit domain types and constants.
 *
 * No platform imports allowed. The financial scale and constants here are the
 * single source of truth shared by the D1 schema (migration 0003), the interest
 * calculation, the state machine and the Worker repository code (later slice).
 *
 * See SPEC.md §3, §4.1 and §4.2.
 */

/**
 * Fixed integer scale used for rates (annual rate and tax rate).
 *
 *   scaled_value = rate × RATE_SCALE
 *   5%   → 5_000_000
 *   20%  → 200_000
 *   0.5% → 5_000
 *
 * Chosen so 6 decimal places of precision are preserved with no binary
 * floating-point arithmetic anywhere in the financial path.
 */
export const RATE_SCALE = 1_000_000;

/**
 * Maximum annual rate accepted by the calculator. A rate above this is treated
 * as a bug or typo and rejected. 100% per year is already extreme for a
 * consumer term deposit; 1000% is a hard sanity ceiling.
 */
export const MAX_ANNUAL_RATE_SCALED = RATE_SCALE * 1_000;

/** Maximum tax rate (100%). Tax above this is rejected. */
export const MAX_TAX_RATE_SCALED = RATE_SCALE;

/** Interest method enum matching the schema CHECK constraint. */
export type InterestMethod = "SIMPLE" | "COMPOUND";

/** Day-count basis enum matching the schema CHECK constraint. */
export type DayCountBasis = "ACT_365" | "ACT_360" | "ACT_ACT";

/** All allowed day-count basis values. */
export const DAY_COUNT_BASES: readonly DayCountBasis[] = ["ACT_365", "ACT_360", "ACT_ACT"];

/**
 * Term-deposit lifecycle states per SPEC §4.2.
 *
 *   DRAFT -> REVIEW_REQUIRED -> ACTIVE -> MATURED_ACTION_REQUIRED -> (terminal closure)
 *   CANCELLED is a terminal outcome reachable only from DRAFT.
 */
export type TermDepositState =
  | "DRAFT"
  | "REVIEW_REQUIRED"
  | "ACTIVE"
  | "MATURED_ACTION_REQUIRED"
  | "SETTLED_TO_ACCOUNT"
  | "RENEWED"
  | "PRETERMINATED"
  | "CANCELLED";

/** All defined term-deposit states. */
export const TERM_DEPOSIT_STATES: readonly TermDepositState[] = [
  "DRAFT",
  "REVIEW_REQUIRED",
  "ACTIVE",
  "MATURED_ACTION_REQUIRED",
  "SETTLED_TO_ACCOUNT",
  "RENEWED",
  "PRETERMINATED",
  "CANCELLED",
];

/** Terminal business outcomes. Records in these states never transition again. */
export const TERMINAL_STATES: ReadonlySet<TermDepositState> = new Set<TermDepositState>([
  "SETTLED_TO_ACCOUNT",
  "RENEWED",
  "PRETERMINATED",
  "CANCELLED",
]);

/** Planned maturity instruction. */
export type MaturityInstruction = "SETTLE_TO_ACCOUNT" | "RENEW" | "PRETERMINATE" | "PENDING";

export const MATURITY_INSTRUCTIONS: readonly MaturityInstruction[] = [
  "SETTLE_TO_ACCOUNT",
  "RENEW",
  "PRETERMINATE",
  "PENDING",
];
