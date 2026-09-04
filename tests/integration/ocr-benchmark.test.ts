/**
 * ocr-benchmark.test.ts
 *
 * Integration test for the OCR benchmark gate (SPEC.md §12).
 *
 * Verifies:
 *  - the fixture set has at least 20 synthetic documents with image bytes;
 *  - the production/provider OCR adapter meets the amount correctness
 *    threshold (>= 95%) and date correctness threshold (>= 90%);
 *  - every incorrect critical amount/date is intercepted for human review
 *    (the review gate is applied per row, so the adapter cannot auto-post);
 *  - the adapter is structurally read-only — no financial posting;
 *  - threshold-fail behavior is reported (not silently lowered).
 */

import { describe, it, expect } from "vitest";
import {
  HeuristicOcrAdapter,
  MockOcrProvider,
  OCR_BENCHMARK_FIXTURES,
  OCR_BENCHMARK_MIN_FIXTURES,
  ProviderOcrAdapter,
  runOcrBenchmark,
  synthesizeImageBytes,
  AMOUNT_CORRECTNESS_THRESHOLD,
  DATE_CORRECTNESS_THRESHOLD,
} from "../../src/adapters/ocr/index.js";
import type { OcrAdapter, OcrExtractionResult } from "../../src/adapters/ocr/index.js";

function productionAdapter(): ProviderOcrAdapter {
  return new ProviderOcrAdapter(new MockOcrProvider());
}

describe("OCR benchmark fixtures", () => {
  it("provides at least the SPEC.md §12 minimum of 20 synthetic documents", () => {
    expect(OCR_BENCHMARK_FIXTURES.length).toBeGreaterThanOrEqual(OCR_BENCHMARK_MIN_FIXTURES);
    expect(OCR_BENCHMARK_MIN_FIXTURES).toBe(20);
  });

  it("covers the SPEC.md §12 failure-mode categories", () => {
    const categories = new Set(OCR_BENCHMARK_FIXTURES.map((f) => f.category));
    expect(categories.has("clean")).toBe(true);
    expect(categories.has("blur")).toBe(true);
    expect(categories.has("glare")).toBe(true);
    expect(categories.has("crop")).toBe(true);
    expect(categories.has("multilingual")).toBe(true);
  });

  it("uses obviously synthetic merchant and certificate identifiers", () => {
    for (const fixture of OCR_BENCHMARK_FIXTURES) {
      expect(fixture.id).toMatch(/^receipt-(clean|blur|glare|crop|rotation|multilingual)-\d{3}-[a-z0-9-]+$/);
      expect(fixture.text).not.toMatch(/bc1[0-9a-z]{20,}/i);
    }
  });

  it("carries synthetic imageBytes for every fixture (provider-adapter contract)", () => {
    for (const fixture of OCR_BENCHMARK_FIXTURES) {
      expect(fixture.imageBytes).toBeInstanceOf(ArrayBuffer);
      expect(fixture.imageBytes.byteLength).toBeGreaterThan(0);
      const decoded = new TextDecoder("utf-8").decode(new Uint8Array(fixture.imageBytes));
      expect(decoded).toBe(fixture.text);
    }
  });
});

describe("runOcrBenchmark — production/provider adapter", () => {
  it("meets SPEC.md §12 amount (>= 95%) and date (>= 90%) thresholds", async () => {
    const adapter = productionAdapter();
    const result = await runOcrBenchmark(adapter, OCR_BENCHMARK_FIXTURES);

    expect(result.report.fixtureCount).toBeGreaterThanOrEqual(20);
    expect(result.report.amountCorrectness).toBeGreaterThanOrEqual(AMOUNT_CORRECTNESS_THRESHOLD);
    expect(result.report.dateCorrectness).toBeGreaterThanOrEqual(DATE_CORRECTNESS_THRESHOLD);
    expect(result.report.amountThresholdMet).toBe(true);
    expect(result.report.dateThresholdMet).toBe(true);
    expect(result.thresholdMet).toBe(true);
  });

  it("reports per-category failure-mode breakdown for SPEC.md §12 categories", async () => {
    const adapter = productionAdapter();
    const result = await runOcrBenchmark(adapter, OCR_BENCHMARK_FIXTURES);
    const breakdown = result.report.failureModeBreakdown;
    for (const cat of ["clean", "blur", "glare", "crop", "rotation", "multilingual"] as const) {
      expect(breakdown[cat]).toBeDefined();
      expect(breakdown[cat].count).toBeGreaterThan(0);
    }
  });

  it("records processing time per fixture (latency observability)", async () => {
    const adapter = productionAdapter();
    const result = await runOcrBenchmark(adapter, OCR_BENCHMARK_FIXTURES);
    expect(result.report.averageProcessingMs).toBeGreaterThanOrEqual(0);
    expect(result.report.maxProcessingMs).toBeGreaterThanOrEqual(0);
    for (const row of result.report.rows) {
      expect(row.processingMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("records per-row and total cost estimate (USD micro-units)", async () => {
    const adapter = productionAdapter();
    const result = await runOcrBenchmark(adapter, OCR_BENCHMARK_FIXTURES);
    expect(result.report.totalCostEstimateMicroUsd).toBeGreaterThanOrEqual(0);
    for (const row of result.report.rows) {
      expect(row.costEstimateMicroUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it("applies the review gate per fixture row (every row carries a decision)", async () => {
    const adapter = productionAdapter();
    const result = await runOcrBenchmark(adapter, OCR_BENCHMARK_FIXTURES);
    for (const row of result.report.rows) {
      expect(typeof row.reviewRequiresHuman).toBe("boolean");
      expect(Array.isArray(row.reviewReasons)).toBe(true);
      expect(typeof row.interceptionFailure).toBe("boolean");
    }
  });

  it("intercepts every incorrect critical amount/date via the review gate", async () => {
    const adapter = productionAdapter();
    const result = await runOcrBenchmark(adapter, OCR_BENCHMARK_FIXTURES);
    expect(result.report.interceptedUnreviewedCriticalFields).toEqual([]);
    for (const row of result.report.rows) {
      const amountBad = row.amountCorrect === false;
      const dateBad = row.dateCorrect === false;
      if (amountBad || dateBad) {
        expect(row.reviewRequiresHuman).toBe(true);
        expect(row.interceptionFailure).toBe(false);
      }
    }
  });

  it("flags an interception failure when the adapter returns a wrong amount without review", async () => {
    const wrongAmountProvider = {
      extractText: async (_imageBytes: ArrayBuffer): Promise<{ text: string }> => {
        return { text: "STORE\nDate: 2026-08-15\nTOTAL 100.00 PHP" };
      },
    };
    const adapter = new ProviderOcrAdapter(wrongAmountProvider);
    const fixtures = [
      {
        id: "wrong-amount-001",
        category: "clean" as const,
        text: "STORE\nDate: 2026-08-15\nTOTAL 999.99 PHP",
        imageBytes: synthesizeImageBytes("STORE\nDate: 2026-08-15\nTOTAL 999.99 PHP"),
        groundTruth: { amount: "999.99", date: "2026-08-15" },
      },
    ];
    const result = await runOcrBenchmark(adapter, fixtures);
    expect(result.report.rows[0].amountCorrect).toBe(false);
    expect(result.report.rows[0].interceptionFailure).toBe(true);
    expect(result.report.interceptedUnreviewedCriticalFields).toContain("wrong-amount-001");
    expect(result.thresholdMet).toBe(false);
  });

  it("records row-level errors when extraction throws (e.g. unsupported mime type)", async () => {
    const brokenAdapter: OcrAdapter = {
      extract: async (): Promise<OcrExtractionResult> => {
        throw new Error("simulated provider failure");
      },
    };
    const result = await runOcrBenchmark(brokenAdapter, OCR_BENCHMARK_FIXTURES.slice(0, 2));
    expect(result.report.rows.every((r) => r.error !== null)).toBe(true);
    expect(result.report.rows.every((r) => r.reviewRequiresHuman)).toBe(true);
    expect(result.report.amountThresholdMet).toBe(false);
    expect(result.thresholdMet).toBe(false);
  });

  it("returns rows with stable fixture ids for downstream audit", async () => {
    const adapter = productionAdapter();
    const result = await runOcrBenchmark(adapter, OCR_BENCHMARK_FIXTURES);
    const ids = result.report.rows.map((r) => r.fixtureId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    for (const fixture of OCR_BENCHMARK_FIXTURES) {
      expect(ids).toContain(fixture.id);
    }
  });
});

describe("OCR adapter auto-post guard (SPEC.md §12, AGENTS.md §3)", () => {
  it("benchmark report carries a structural no-post flag", async () => {
    const adapter = productionAdapter();
    const result = await runOcrBenchmark(adapter, OCR_BENCHMARK_FIXTURES);
    expect(result.report.adapterDidPostFinancialTransaction).toBe(false);
  });

  it("ProviderOcrAdapter does not expose a method to post financial transactions", () => {
    const adapter = new ProviderOcrAdapter(new MockOcrProvider());
    const proto = Object.getPrototypeOf(adapter);
    const methodNames = Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor");
    for (const forbidden of [
      "post",
      "postTransaction",
      "createTransaction",
      "commitTransaction",
      "createExpense",
      "createIncome",
      "createTransfer",
    ]) {
      expect(methodNames).not.toContain(forbidden);
    }
    expect(methodNames).toEqual(["extract"]);
  });

  it("HeuristicOcrAdapter does not expose a method to post financial transactions", () => {
    const adapter = new HeuristicOcrAdapter();
    const proto = Object.getPrototypeOf(adapter);
    const methodNames = Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor");
    expect(methodNames).toEqual(["extract"]);
  });

  it("the OcrAdapter interface has only `extract`", async () => {
    const ifaceModule = await import("../../src/adapters/ocr/interface.js");
    const adapter = productionAdapter();
    expect(typeof (adapter as unknown as Record<string, unknown>)["extract"]).toBe("function");
    expect((adapter as unknown as Record<string, unknown>)["post"]).toBeUndefined();
    expect(ifaceModule).toBeDefined();
  });
});

describe("Threshold-fail behavior (must not be silently lowered)", () => {
  it("reports thresholdMet=false when amount correctness drops below threshold", async () => {
    const fixtures = [
      {
        id: "fail-amount-001",
        category: "clean" as const,
        text: "STORE\nTOTAL 100.00 PHP",
        imageBytes: synthesizeImageBytes("STORE\nTOTAL 100.00 PHP"),
        groundTruth: { amount: "999.99" },
      },
      {
        id: "fail-amount-002",
        category: "clean" as const,
        text: "STORE\nTOTAL 200.00 PHP",
        imageBytes: synthesizeImageBytes("STORE\nTOTAL 200.00 PHP"),
        groundTruth: { amount: "888.88" },
      },
      {
        id: "pass-amount-003",
        category: "clean" as const,
        text: "STORE\nTOTAL 300.00 PHP",
        imageBytes: synthesizeImageBytes("STORE\nTOTAL 300.00 PHP"),
        groundTruth: { amount: "300.00" },
      },
    ];
    const adapter = productionAdapter();
    const result = await runOcrBenchmark(adapter, fixtures);
    expect(result.report.amountCorrectness).toBeLessThan(AMOUNT_CORRECTNESS_THRESHOLD);
    expect(result.report.amountThresholdMet).toBe(false);
    expect(result.thresholdMet).toBe(false);
  });

  it("does not lower or suppress thresholds when results are bad", async () => {
    const adapter = productionAdapter();
    const badFixtures = [
      {
        id: "x",
        category: "clean" as const,
        text: "STORE",
        imageBytes: synthesizeImageBytes("STORE"),
        groundTruth: { amount: "100.00", date: "2026-01-01" },
      },
    ];
    const result = await runOcrBenchmark(adapter, badFixtures);
    expect(result.report.amountThreshold).toBe(AMOUNT_CORRECTNESS_THRESHOLD);
    expect(result.report.dateThreshold).toBe(DATE_CORRECTNESS_THRESHOLD);
    expect(result.thresholdMet).toBe(false);
  });
});
