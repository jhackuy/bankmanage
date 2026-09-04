/**
 * ocr-confidence.test.ts
 *
 * Tests for the OCR review gate.
 *
 * Verifies SPEC.md §12 / AGENTS.md §3: low-confidence or missing critical
 * fields MUST require human review. The gate is the structural enforcement
 * that proves the adapter can never auto-post a financial transaction.
 */

import { describe, it, expect } from "vitest";
import {
  parseOcrText,
  decideOcrReview,
  isCriticalFieldLowConfidence,
  DEFAULT_CRITICAL_CONFIDENCE_THRESHOLD,
} from "../../src/adapters/ocr/index.js";

describe("decideOcrReview", () => {
  it("requires review when amount candidate is missing", () => {
    const result = parseOcrText("ACME STORE\nDate: 2026-08-15");
    const decision = decideOcrReview(result);
    expect(decision.requiresReview).toBe(true);
    expect(decision.reasons.some((r) => r.includes("missing total amount"))).toBe(true);
  });

  it("requires review when date candidate is missing", () => {
    const result = parseOcrText("ACME STORE\nTOTAL 100.00");
    const decision = decideOcrReview(result);
    expect(decision.requiresReview).toBe(true);
    expect(decision.reasons.some((r) => r.includes("missing date"))).toBe(true);
  });

  it("requires review when amount confidence is below the threshold", () => {
    const result = parseOcrText(["Item A 10.00", "Item B 20.00", "Item C 30.00"].join("\n"));
    // No TOTAL/DUE label → falls back to largest-amount heuristic with sub-threshold confidence.
    expect(result.totalAmountCandidate?.confidence).toBeLessThan(DEFAULT_CRITICAL_CONFIDENCE_THRESHOLD);
    const decision = decideOcrReview(result);
    expect(decision.requiresReview).toBe(true);
  });

  it("passes review for explicitly labeled TOTAL with high confidence", () => {
    const result = parseOcrText(["ACME", "Date: 2026-08-15", "TOTAL 100.00 PHP"].join("\n"));
    const decision = decideOcrReview(result);
    expect(decision.requiresReview).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it("exposes confidence values for observability", () => {
    const result = parseOcrText("Date: 2026-08-15\nTOTAL 100.00 PHP");
    const decision = decideOcrReview(result);
    expect(decision.amountConfidence).toBeGreaterThanOrEqual(0.9);
    expect(decision.dateConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it("allows a custom threshold override", () => {
    const result = parseOcrText(["ACME", "Date: 2026-08-15", "TOTAL 100.00"].join("\n"));
    // With a strict threshold (0.99), even a labeled TOTAL might fall below
    expect(decideOcrReview(result, 0.99).requiresReview).toBe(true);
    // With the default threshold, it passes
    expect(decideOcrReview(result, 0.7).requiresReview).toBe(false);
  });

  it("requires review when both critical fields are missing", () => {
    const result = parseOcrText("ACME STORE");
    const decision = decideOcrReview(result);
    expect(decision.requiresReview).toBe(true);
    expect(decision.reasons.length).toBe(2);
  });
});

describe("isCriticalFieldLowConfidence", () => {
  it("returns true when field is undefined", () => {
    expect(isCriticalFieldLowConfidence(undefined)).toBe(true);
  });

  it("returns true when confidence is below threshold", () => {
    expect(isCriticalFieldLowConfidence({ value: "100", confidence: 0.5 })).toBe(true);
  });

  it("returns false when confidence meets threshold", () => {
    expect(isCriticalFieldLowConfidence({ value: "100", confidence: 0.9 })).toBe(false);
  });

  it("returns false when confidence equals threshold", () => {
    expect(
      isCriticalFieldLowConfidence({ value: "100", confidence: DEFAULT_CRITICAL_CONFIDENCE_THRESHOLD })
    ).toBe(false);
  });
});

describe("Auto-post guard (SPEC.md §12 + AGENTS.md §3)", () => {
  it("the adapter returns candidate fields, never a posted transaction", async () => {
    const { HeuristicOcrAdapter } = await import("../../src/adapters/ocr/index.js");
    const a = new HeuristicOcrAdapter();
    const text = "ACME\nDate: 2026-08-15\nTOTAL 100.00 PHP";
    const result = await a.extract(new TextEncoder().encode(text).buffer, "text/plain");

    // Structural proof: the result type has no field that could post.
    const keys = Object.keys(result);
    expect(keys).not.toContain("transactionId");
    expect(keys).not.toContain("postedAt");
    expect(keys).not.toContain("balance");
    expect(keys).not.toContain("ledgerEntry");
  });

  it("low-confidence critical fields require review (never auto-post)", () => {
    // Document with ambiguous date → 0.7 confidence → MUST require review
    const result = parseOcrText(["ACME", "TOTAL 100.00", "Date: 05/06/2026"].join("\n"));
    const decision = decideOcrReview(result);
    expect(decision.requiresReview).toBe(true);
    expect(decision.dateConfidence).toBeLessThan(DEFAULT_CRITICAL_CONFIDENCE_THRESHOLD);
  });
});
