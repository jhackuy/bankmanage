/**
 * Term-deposit domain barrel.
 *
 * Re-exports the platform-neutral types, interest calculation and state
 * machine. The Worker / D1 / R2 / Telegram / UI layers must depend on this
 * module rather than reaching into Hono, D1, R2, Wrangler or any UI code.
 */

export {
  RATE_SCALE,
  MAX_ANNUAL_RATE_SCALED,
  MAX_TAX_RATE_SCALED,
  DAY_COUNT_BASES,
  TERM_DEPOSIT_STATES,
  TERMINAL_STATES,
  MATURITY_INSTRUCTIONS,
  type InterestMethod,
  type DayCountBasis,
  type TermDepositState,
  type MaturityInstruction,
} from "./types.js";

export {
  calculateSimpleInterest,
  calculateEstimate,
  dayCountBetween,
  type InterestInputs,
  type InterestEstimate,
  type DayCountResult,
} from "./interest.js";

export {
  canTransition,
  isTerminalState,
  transition,
  type SettleToAccountGateInput,
  type RenewGateInput,
  type PreterminateGateInput,
  type CancelGateInput,
  type ClosureGateInput,
  type TransitionRequest,
  type TransitionResult,
} from "./state-machine.js";
