/**
 * Term-deposit state machine tests.
 *
 * Verifies SPEC §4.2 lifecycle and §4.3 maturity closure gates:
 *   - DRAFT -> REVIEW_REQUIRED -> ACTIVE -> MATURED_ACTION_REQUIRED -> terminal
 *   - CANCELLED is reachable only from DRAFT.
 *   - Closure states (SETTLED_TO_ACCOUNT, RENEWED, PRETERMINATED) require
 *     matching, well-formed closure-gate inputs.
 *   - Terminal states cannot transition further.
 *   - A generic state setter cannot reach a closure state without a gate.
 */

import { describe, it, expect } from "vitest";
import {
  canTransition,
  isTerminalState,
  transition,
  TERMINAL_STATES,
  TERM_DEPOSIT_STATES,
  type ClosureGateInput,
  type TermDepositState,
} from "../../src/domain/term-deposit/index.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function validSettleGate(): ClosureGateInput {
  return {
    kind: "SETTLE_TO_ACCOUNT",
    settlementAccountId: 42,
    evidenceRef: "fakesigned://documents/settlement-evidence-1.pdf",
    actualSettlementDate: "2026-04-02",
    actualReceivedTotalMinor: 10_098_630,
    actualGrossInterestMinor: 123_288,
    actualTaxMinor: 24_658,
    actualPenaltyFeesMinor: 0,
    balancedLedgerRef: "ledger://batch/settlement-1",
  };
}

function validPreterminateGate(): ClosureGateInput {
  return {
    kind: "PRETERMINATE",
    settlementAccountId: 42,
    evidenceRef: "fakesigned://documents/preterm-evidence-1.pdf",
    actualSettlementDate: "2026-03-15",
    actualReceivedTotalMinor: 9_900_000,
    actualGrossInterestMinor: 0,
    actualTaxMinor: 0,
    actualPenaltyFeesMinor: 100_000,
    balancedLedgerRef: "ledger://batch/preterminate-1",
  };
}

function validRenewGate(): ClosureGateInput {
  return {
    kind: "RENEW",
    evidenceRef: "fakesigned://documents/renewal-advice-1.pdf",
    successorDepositId: 999,
    newPrincipalMinor: 10_098_630,
    newRateScaled: 50_000,
    newStartDate: "2026-04-02",
    newMaturityDate: "2026-10-02",
    interestDisposition: "CAPITALIZED",
  };
}

// ── Terminal-state detection ────────────────────────────────────────────────

describe("terminal states", () => {
  it("identifies SETTLED_TO_ACCOUNT as terminal", () => {
    expect(isTerminalState("SETTLED_TO_ACCOUNT")).toBe(true);
  });

  it("identifies RENEWED as terminal", () => {
    expect(isTerminalState("RENEWED")).toBe(true);
  });

  it("identifies PRETERMINATED as terminal", () => {
    expect(isTerminalState("PRETERMINATED")).toBe(true);
  });

  it("identifies CANCELLED as terminal", () => {
    expect(isTerminalState("CANCELLED")).toBe(true);
  });

  it("DRAFT, REVIEW_REQUIRED, ACTIVE, MATURED_ACTION_REQUIRED are non-terminal", () => {
    const nonTerminal: TermDepositState[] = ["DRAFT", "REVIEW_REQUIRED", "ACTIVE", "MATURED_ACTION_REQUIRED"];
    for (const s of nonTerminal) {
      expect(isTerminalState(s)).toBe(false);
    }
  });

  it("TERMINAL_STATES exposes the four terminal states", () => {
    expect(TERMINAL_STATES.size).toBe(4);
    expect(TERMINAL_STATES.has("SETTLED_TO_ACCOUNT")).toBe(true);
    expect(TERMINAL_STATES.has("RENEWED")).toBe(true);
    expect(TERMINAL_STATES.has("PRETERMINATED")).toBe(true);
    expect(TERMINAL_STATES.has("CANCELLED")).toBe(true);
  });

  it("TERM_DEPOSIT_STATES enumerates all 8 lifecycle states", () => {
    expect(TERM_DEPOSIT_STATES.length).toBe(8);
  });
});

// ── Allowed forward transitions (SPEC §4.2) ─────────────────────────────────

describe("allowed transitions", () => {
  it("DRAFT -> REVIEW_REQUIRED is allowed", () => {
    expect(canTransition("DRAFT", "REVIEW_REQUIRED")).toBe(true);
    expect(transition({ from: "DRAFT", to: "REVIEW_REQUIRED" })).toEqual({ ok: true });
  });

  it("DRAFT -> CANCELLED is allowed", () => {
    expect(canTransition("DRAFT", "CANCELLED")).toBe(true);
    expect(transition({ from: "DRAFT", to: "CANCELLED" })).toEqual({ ok: true });
  });

  it("REVIEW_REQUIRED -> ACTIVE is allowed", () => {
    expect(canTransition("REVIEW_REQUIRED", "ACTIVE")).toBe(true);
    expect(transition({ from: "REVIEW_REQUIRED", to: "ACTIVE" })).toEqual({ ok: true });
  });

  it("ACTIVE -> MATURED_ACTION_REQUIRED is allowed", () => {
    expect(canTransition("ACTIVE", "MATURED_ACTION_REQUIRED")).toBe(true);
    expect(transition({ from: "ACTIVE", to: "MATURED_ACTION_REQUIRED" })).toEqual({
      ok: true,
    });
  });

  it("MATURED_ACTION_REQUIRED -> SETTLED_TO_ACCOUNT is allowed with gate", () => {
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
      gate: validSettleGate(),
    });
    expect(result).toEqual({ ok: true });
  });

  it("MATURED_ACTION_REQUIRED -> RENEWED is allowed with gate", () => {
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "RENEWED",
      gate: validRenewGate(),
    });
    expect(result).toEqual({ ok: true });
  });

  it("MATURED_ACTION_REQUIRED -> PRETERMINATED is allowed with gate", () => {
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "PRETERMINATED",
      gate: validPreterminateGate(),
    });
    expect(result).toEqual({ ok: true });
  });
});

// ── Illegal transitions ─────────────────────────────────────────────────────

describe("illegal transitions", () => {
  it("DRAFT -> ACTIVE is illegal (must go through REVIEW_REQUIRED)", () => {
    expect(canTransition("DRAFT", "ACTIVE")).toBe(false);
    const result = transition({ from: "DRAFT", to: "ACTIVE" });
    expect(result.ok).toBe(false);
  });

  it("DRAFT -> SETTLED_TO_ACCOUNT is illegal", () => {
    expect(canTransition("DRAFT", "SETTLED_TO_ACCOUNT")).toBe(false);
  });

  it("DRAFT -> RENEWED is illegal", () => {
    expect(canTransition("DRAFT", "RENEWED")).toBe(false);
  });

  it("DRAFT -> PRETERMINATED is illegal", () => {
    expect(canTransition("DRAFT", "PRETERMINATED")).toBe(false);
  });

  it("REVIEW_REQUIRED -> DRAFT is illegal (no backward)", () => {
    expect(canTransition("REVIEW_REQUIRED", "DRAFT")).toBe(false);
  });

  it("REVIEW_REQUIRED -> CANCELLED is illegal (must go through ACTIVE first)", () => {
    expect(canTransition("REVIEW_REQUIRED", "CANCELLED")).toBe(false);
  });

  it("REVIEW_REQUIRED -> MATURED_ACTION_REQUIRED is illegal (must go through ACTIVE)", () => {
    expect(canTransition("REVIEW_REQUIRED", "MATURED_ACTION_REQUIRED")).toBe(false);
  });

  it("ACTIVE -> CANCELLED is illegal", () => {
    expect(canTransition("ACTIVE", "CANCELLED")).toBe(false);
  });

  it("ACTIVE -> SETTLED_TO_ACCOUNT is illegal (must go through MATURED_ACTION_REQUIRED)", () => {
    expect(canTransition("ACTIVE", "SETTLED_TO_ACCOUNT")).toBe(false);
  });

  it("ACTIVE -> DRAFT is illegal (no backward)", () => {
    expect(canTransition("ACTIVE", "DRAFT")).toBe(false);
  });

  it("MATURED_ACTION_REQUIRED -> ACTIVE is illegal (no backward)", () => {
    expect(canTransition("MATURED_ACTION_REQUIRED", "ACTIVE")).toBe(false);
  });

  it("same-state transitions are illegal", () => {
    const states: TermDepositState[] = ["DRAFT", "REVIEW_REQUIRED", "ACTIVE", "MATURED_ACTION_REQUIRED"];
    for (const s of states) {
      expect(canTransition(s, s)).toBe(false);
    }
  });
});

// ── Terminal states cannot transition ───────────────────────────────────────

describe("terminal-state behaviour", () => {
  const terminals: TermDepositState[] = ["SETTLED_TO_ACCOUNT", "RENEWED", "PRETERMINATED", "CANCELLED"];

  for (const from of terminals) {
    it(`${from} cannot transition to any other state`, () => {
      for (const to of TERM_DEPOSIT_STATES) {
        if (to === from) continue;
        expect(canTransition(from, to)).toBe(false);
        const result = transition({ from, to });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toMatch(/Terminal state/);
        }
      }
    });
  }
});

// ── Closure gates cannot be bypassed ────────────────────────────────────────

describe("closure gates cannot be bypassed", () => {
  it("SETTLED_TO_ACCOUNT requires a gate", () => {
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/SETTLE_TO_ACCOUNT closure requires a gate/);
    }
  });

  it("RENEWED requires a RENEW gate", () => {
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "RENEWED",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/RENEWED closure requires a RENEW gate/);
    }
  });

  it("PRETERMINATED requires a gate", () => {
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "PRETERMINATED",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/PRETERMINATE closure requires a gate/);
    }
  });

  it("SETTLED_TO_ACCOUNT rejects a RENEW gate (wrong kind)", () => {
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
      gate: validRenewGate(),
    });
    expect(result.ok).toBe(false);
  });

  it("PRETERMINATED rejects a SETTLE gate (wrong kind)", () => {
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "PRETERMINATED",
      gate: validSettleGate(),
    });
    expect(result.ok).toBe(false);
  });

  it("RENEWED rejects a SETTLE gate (wrong kind)", () => {
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "RENEWED",
      gate: validSettleGate(),
    });
    expect(result.ok).toBe(false);
  });
});

// ── Settle-gate field validation ────────────────────────────────────────────

describe("settle-gate field validation", () => {
  it("rejects empty evidenceRef", () => {
    const gate = { ...validSettleGate(), evidenceRef: "   " };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-positive settlementAccountId", () => {
    const gate = { ...validSettleGate(), settlementAccountId: 0 };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unsafe integer closure IDs", () => {
    const gate = {
      ...validSettleGate(),
      settlementAccountId: Number.MAX_SAFE_INTEGER + 1,
    };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects negative actualReceivedTotalMinor", () => {
    const gate = { ...validSettleGate(), actualReceivedTotalMinor: -1 };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed actualSettlementDate", () => {
    const gate = { ...validSettleGate(), actualSettlementDate: "04/02/2026" };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-integer actualReceivedTotalMinor", () => {
    const gate = { ...validSettleGate(), actualReceivedTotalMinor: 1.5 as number };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("zero actualReceivedTotalMinor is allowed (full penalty/zero-credit path)", () => {
    const gate = { ...validSettleGate(), actualReceivedTotalMinor: 0 };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
      gate,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects closure without a balanced ledger reference", () => {
    const gate = { ...validSettleGate(), balancedLedgerRef: " " };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects negative actual tax/fee facts", () => {
    const gate = { ...validSettleGate(), actualTaxMinor: -1 };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "SETTLED_TO_ACCOUNT",
      gate,
    });
    expect(result.ok).toBe(false);
  });
});

// ── Renew-gate field validation ─────────────────────────────────────────────

describe("renew-gate field validation", () => {
  it("rejects empty evidenceRef", () => {
    const gate = { ...validRenewGate(), evidenceRef: "" };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "RENEWED",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-positive successorDepositId", () => {
    const gate = { ...validRenewGate(), successorDepositId: 0 };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "RENEWED",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects negative newPrincipalMinor", () => {
    const gate = { ...validRenewGate(), newPrincipalMinor: -1 };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "RENEWED",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects negative newRateScaled", () => {
    const gate = { ...validRenewGate(), newRateScaled: -1 };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "RENEWED",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed newStartDate", () => {
    const gate = { ...validRenewGate(), newStartDate: "2026/04/02" };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "RENEWED",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed newMaturityDate", () => {
    const gate = { ...validRenewGate(), newMaturityDate: "not-a-date" };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "RENEWED",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("requires a settlement account when renewed interest is paid out", () => {
    const gate = {
      ...validRenewGate(),
      interestDisposition: "SETTLED_TO_ACCOUNT" as const,
    };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "RENEWED",
      gate,
    });
    expect(result.ok).toBe(false);
  });

  it("records a valid renewed-interest settlement destination", () => {
    const gate = {
      ...validRenewGate(),
      interestDisposition: "SETTLED_TO_ACCOUNT" as const,
      interestSettlementAccountId: 42,
    };
    const result = transition({
      from: "MATURED_ACTION_REQUIRED",
      to: "RENEWED",
      gate,
    });
    expect(result).toEqual({ ok: true });
  });
});

// ── CANCELLED does not require evidence ─────────────────────────────────────

describe("CANCELLED does not require evidence", () => {
  it("DRAFT -> CANCELLED is allowed without a gate", () => {
    const result = transition({ from: "DRAFT", to: "CANCELLED" });
    expect(result).toEqual({ ok: true });
  });

  it("DRAFT -> CANCELLED is allowed with an explicit CANCEL gate", () => {
    const result = transition({
      from: "DRAFT",
      to: "CANCELLED",
      gate: { kind: "CANCEL" },
    });
    expect(result).toEqual({ ok: true });
  });

  it("DRAFT -> CANCELLED rejects a mismatched closure gate", () => {
    const result = transition({
      from: "DRAFT",
      to: "CANCELLED",
      gate: validRenewGate(),
    });
    expect(result.ok).toBe(false);
  });

  it("CANCELLED is never reachable from non-DRAFT states", () => {
    const nonDraft: TermDepositState[] = ["REVIEW_REQUIRED", "ACTIVE", "MATURED_ACTION_REQUIRED"];
    for (const from of nonDraft) {
      expect(canTransition(from, "CANCELLED")).toBe(false);
    }
  });
});

// ── No partial mutation invariant ───────────────────────────────────────────

describe("no partial mutation on rejection", () => {
  it("transition() is a pure validator; no side effects are observable", () => {
    // Call it many times; the outcome must be fully deterministic and
    // depend only on inputs. We don't expose any mutable state here, but
    // asserting the result is identical on repeat guards against future
    // refactors that accidentally introduce state.
    const req = {
      from: "MATURED_ACTION_REQUIRED" as const,
      to: "SETTLED_TO_ACCOUNT" as const,
    };
    const first = transition(req);
    const second = transition(req);
    expect(first).toEqual(second);
    expect(first.ok).toBe(false);
  });
});
