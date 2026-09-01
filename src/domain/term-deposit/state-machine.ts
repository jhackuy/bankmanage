/**
 * Term-deposit state machine.
 *
 * Platform-neutral domain code: NO Hono, NO D1, NO R2, NO Telegram, NO UI.
 *
 * Implements SPEC.md §4.2 (lifecycle) and §4.3 (maturity closure gates).
 *
 * Closure states (SETTLED_TO_ACCOUNT, RENEWED, PRETERMINATED) MUST NOT be
 * reachable by a generic state setter without supplying a closure-gate input
 * with the evidence/ledger fields required by the spec. CANCELLED is a draft
 * outcome that does not require evidence.
 *
 * This module validates transitions and closure-gate inputs only. It does NOT
 * write ledger entries or persist evidence; those responsibilities belong to
 * the repository / service layer in later slices (M2 for ledger, M3 for R2
 * evidence handling). M1A defines the gate interface and refuses transitions
 * that would skip the gate.
 */

import { TERMINAL_STATES, type TermDepositState } from "./types.js";

// ── Closure-gate input types (interfaces/stubs per M1A) ─────────────────────

/** Required evidence/ledger inputs for a SETTLED_TO_ACCOUNT closure. */
export interface SettleToAccountGateInput {
  readonly kind: "SETTLE_TO_ACCOUNT";
  readonly settlementAccountId: number;
  /** Opaque reference (e.g. R2 document key) to the credit/settlement evidence. */
  readonly evidenceRef: string;
  /** ISO 'YYYY-MM-DD'. */
  readonly actualSettlementDate: string;
  readonly actualReceivedTotalMinor: number;
  readonly actualGrossInterestMinor: number;
  readonly actualTaxMinor: number;
  readonly actualPenaltyFeesMinor: number;
  /** Opaque reference to a balanced ledger batch created by the ledger service. */
  readonly balancedLedgerRef: string;
}

/** Required evidence/ledger inputs for a RENEWED closure. */
export interface RenewGateInput {
  readonly kind: "RENEW";
  /** Opaque reference to the new certificate / Renewal Advice evidence. */
  readonly evidenceRef: string;
  readonly successorDepositId: number;
  readonly newPrincipalMinor: number;
  readonly newRateScaled: number;
  readonly newStartDate: string;
  readonly newMaturityDate: string;
  readonly interestDisposition: "CAPITALIZED" | "SETTLED_TO_ACCOUNT";
  readonly interestSettlementAccountId?: number;
}

/** Required evidence/ledger inputs for a PRETERMINATED closure. */
export interface PreterminateGateInput {
  readonly kind: "PRETERMINATE";
  readonly settlementAccountId: number;
  readonly evidenceRef: string;
  readonly actualSettlementDate: string;
  readonly actualReceivedTotalMinor: number;
  readonly actualGrossInterestMinor: number;
  readonly actualTaxMinor: number;
  readonly actualPenaltyFeesMinor: number;
  /** Opaque reference to a balanced ledger batch created by the ledger service. */
  readonly balancedLedgerRef: string;
}

/** CANCELLED is a draft outcome; no evidence required. */
export interface CancelGateInput {
  readonly kind: "CANCEL";
}

export type ClosureGateInput =
  | SettleToAccountGateInput
  | RenewGateInput
  | PreterminateGateInput
  | CancelGateInput;

// ── Transition request / result ─────────────────────────────────────────────

export interface TransitionRequest {
  readonly from: TermDepositState;
  readonly to: TermDepositState;
  readonly gate?: ClosureGateInput;
}

export type TransitionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// ── Allowed forward transitions (SPEC §4.2) ─────────────────────────────────

const ALLOWED: ReadonlyMap<TermDepositState, ReadonlySet<TermDepositState>> = new Map([
  ["DRAFT", new Set<TermDepositState>(["REVIEW_REQUIRED", "CANCELLED"])],
  ["REVIEW_REQUIRED", new Set<TermDepositState>(["ACTIVE"])],
  ["ACTIVE", new Set<TermDepositState>(["MATURED_ACTION_REQUIRED"])],
  [
    "MATURED_ACTION_REQUIRED",
    new Set<TermDepositState>(["SETTLED_TO_ACCOUNT", "RENEWED", "PRETERMINATED"]),
  ],
]);

/** True if the transition `from -> to` is permitted by the lifecycle graph. */
export function canTransition(from: TermDepositState, to: TermDepositState): boolean {
  if (TERMINAL_STATES.has(from)) {
    return false;
  }
  const allowed = ALLOWED.get(from);
  if (allowed === undefined) {
    return false;
  }
  return allowed.has(to);
}

/** True if the state is a terminal business outcome. */
export function isTerminalState(state: TermDepositState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Validate a transition request including its closure-gate input.
 *
 * Returns `{ ok: true }` only when:
 *   - the transition is allowed by the lifecycle graph;
 *   - the source state is not terminal;
 *   - for closure states (SETTLED_TO_ACCOUNT / RENEWED / PRETERMINATED) a
 *     matching, well-formed closure-gate input is provided.
 *
 * Any failure produces `{ ok: false, reason }` without mutating anything.
 */
export function transition(req: TransitionRequest): TransitionResult {
  if (TERMINAL_STATES.has(req.from)) {
    return {
      ok: false,
      reason: `Terminal state ${req.from} cannot transition to ${req.to}`,
    };
  }
  const allowed = ALLOWED.get(req.from);
  if (allowed === undefined || !allowed.has(req.to)) {
    return { ok: false, reason: `Illegal transition: ${req.from} -> ${req.to}` };
  }
  return validateClosureGate(req.to, req.gate);
}

// ── Gate validation ─────────────────────────────────────────────────────────

function validateClosureGate(to: TermDepositState, gate: ClosureGateInput | undefined): TransitionResult {
  switch (to) {
    case "SETTLED_TO_ACCOUNT":
      return validateSettleGate(gate, "SETTLE_TO_ACCOUNT");
    case "PRETERMINATED":
      return validateSettleGate(gate, "PRETERMINATE");
    case "RENEWED":
      return validateRenewGate(gate);
    case "CANCELLED":
      // No evidence required for draft cancellation.
      return { ok: true };
    default:
      return { ok: true };
  }
}

type SettleKind = "SETTLE_TO_ACCOUNT" | "PRETERMINATE";

function validateSettleGate(
  gate: ClosureGateInput | undefined,
  expectedKind: SettleKind
): TransitionResult {
  if (gate === undefined) {
    return { ok: false, reason: `${expectedKind} closure requires a gate input` };
  }
  if (gate.kind !== expectedKind) {
    return {
      ok: false,
      reason: `${expectedKind} closure requires gate kind ${expectedKind}, got ${gate.kind}`,
    };
  }
  if (!Number.isInteger(gate.settlementAccountId) || gate.settlementAccountId <= 0) {
    return { ok: false, reason: "settlementAccountId must be a positive integer" };
  }
  if (typeof gate.evidenceRef !== "string" || gate.evidenceRef.trim() === "") {
    return { ok: false, reason: "evidenceRef is required" };
  }
  if (!isIsoDate(gate.actualSettlementDate)) {
    return { ok: false, reason: "actualSettlementDate must be ISO YYYY-MM-DD" };
  }
  if (!Number.isInteger(gate.actualReceivedTotalMinor) || gate.actualReceivedTotalMinor < 0) {
    return { ok: false, reason: "actualReceivedTotalMinor must be a non-negative integer" };
  }
  for (const [name, value] of [
    ["actualGrossInterestMinor", gate.actualGrossInterestMinor],
    ["actualTaxMinor", gate.actualTaxMinor],
    ["actualPenaltyFeesMinor", gate.actualPenaltyFeesMinor],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      return { ok: false, reason: `${name} must be a non-negative integer` };
    }
  }
  if (typeof gate.balancedLedgerRef !== "string" || gate.balancedLedgerRef.trim() === "") {
    return { ok: false, reason: "balancedLedgerRef is required" };
  }
  return { ok: true };
}

function validateRenewGate(gate: ClosureGateInput | undefined): TransitionResult {
  if (gate === undefined) {
    return { ok: false, reason: "RENEWED closure requires a RENEW gate input" };
  }
  if (gate.kind !== "RENEW") {
    return {
      ok: false,
      reason: `RENEWED closure requires gate kind RENEW, got ${gate.kind}`,
    };
  }
  if (typeof gate.evidenceRef !== "string" || gate.evidenceRef.trim() === "") {
    return { ok: false, reason: "evidenceRef is required" };
  }
  if (!Number.isInteger(gate.successorDepositId) || gate.successorDepositId <= 0) {
    return { ok: false, reason: "successorDepositId must be a positive integer" };
  }
  if (!Number.isInteger(gate.newPrincipalMinor) || gate.newPrincipalMinor < 0) {
    return { ok: false, reason: "newPrincipalMinor must be a non-negative integer" };
  }
  if (!Number.isInteger(gate.newRateScaled) || gate.newRateScaled < 0) {
    return { ok: false, reason: "newRateScaled must be a non-negative integer" };
  }
  if (!isIsoDate(gate.newStartDate)) {
    return { ok: false, reason: "newStartDate must be ISO YYYY-MM-DD" };
  }
  if (!isIsoDate(gate.newMaturityDate)) {
    return { ok: false, reason: "newMaturityDate must be ISO YYYY-MM-DD" };
  }
  if (gate.newMaturityDate < gate.newStartDate) {
    return { ok: false, reason: "newMaturityDate must not be before newStartDate" };
  }
  if (
    gate.interestDisposition !== "CAPITALIZED" &&
    gate.interestDisposition !== "SETTLED_TO_ACCOUNT"
  ) {
    return { ok: false, reason: "interestDisposition is invalid" };
  }
  if (
    gate.interestDisposition === "SETTLED_TO_ACCOUNT" &&
    (!Number.isInteger(gate.interestSettlementAccountId) ||
      (gate.interestSettlementAccountId ?? 0) <= 0)
  ) {
    return {
      ok: false,
      reason: "interestSettlementAccountId is required when interest is settled",
    };
  }
  return { ok: true };
}

function isIsoDate(s: string): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return false;
  }
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}
