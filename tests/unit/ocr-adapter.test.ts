/**
 * ocr-adapter.test.ts
 *
 * Unit tests for the HeuristicOcrAdapter. Verifies the production-path
 * adapter contract:
 *  - Returns OcrExtractionResult candidate fields only.
 *  - Never returns a posted transaction, transaction id, or balance change.
 *  - Records processingMs latency.
 *  - Rejects unsupported mime types.
 *  - Decodes text bytes deterministically.
 */

import { describe, it, expect } from "vitest";
import { HeuristicOcrAdapter } from "../../src/adapters/ocr/index.js";
import type { OcrAdapter } from "../../src/adapters/ocr/index.js";

describe("HeuristicOcrAdapter", () => {
  const adapter = new HeuristicOcrAdapter();

  it("implements the OcrAdapter interface (no financial-post method)", () => {
    const a: OcrAdapter = adapter;
    // Structural verification: the interface has only `extract`.
    expect(typeof a.extract).toBe("function");
    const ownProperties = Object.getOwnPropertyNames(Object.getPrototypeOf(a));
    expect(ownProperties).toContain("extract");
    expect(ownProperties).not.toContain("postTransaction");
    expect(ownProperties).not.toContain("createTransaction");
    expect(ownProperties).not.toContain("commitTransaction");
  });

  it("returns OcrExtractionResult candidate fields only", async () => {
    const text = "ACME STORE\nDate: 2026-08-15\nTOTAL 100.00 PHP\nPayment: CASH";
    const bytes = new TextEncoder().encode(text).buffer;
    const result = await adapter.extract(bytes, "text/plain");

    expect(result.totalAmountCandidate).toBeDefined();
    expect(result.dateCandidate).toBeDefined();
    expect(result.currencyCandidate).toBeDefined();
    expect(result.paymentMethodCandidate).toBeDefined();
    expect(result.processingMs).toBeGreaterThanOrEqual(0);
  });

  it("does not include any posted-transaction field in the result", async () => {
    const text = "ACME\nTOTAL 100.00";
    const result = await adapter.extract(new TextEncoder().encode(text).buffer, "text/plain");
    const keys = Object.keys(result);
    for (const forbidden of [
      "transactionId",
      "postedAt",
      "postedTransaction",
      "committedAt",
      "balance",
      "balanceChange",
      "ledgerEntry",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("records non-negative processingMs latency", async () => {
    const text = "ACME\nTOTAL 100.00";
    const result = await adapter.extract(new TextEncoder().encode(text).buffer, "text/plain");
    expect(result.processingMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.processingMs)).toBe(true);
  });

  it("rejects unsupported mime types", async () => {
    const bytes = new Uint8Array([0, 1, 2]).buffer;
    await expect(adapter.extract(bytes, "image/png")).rejects.toThrow(/unsupported mime type/);
    await expect(adapter.extract(bytes, "application/pdf")).rejects.toThrow(/unsupported mime type/);
  });

  it("accepts text/plain mime type", async () => {
    const bytes = new TextEncoder().encode("TOTAL 100.00").buffer;
    const result = await adapter.extract(bytes, "text/plain");
    expect(result.totalAmountCandidate?.value).toBe("100.00");
  });

  it("accepts text/html mime type", async () => {
    const bytes = new TextEncoder().encode("TOTAL 50.00 PHP").buffer;
    const result = await adapter.extract(bytes, "text/html");
    expect(result.totalAmountCandidate?.value).toBe("50.00");
  });

  it("decodes UTF-8 text bytes correctly", async () => {
    const text = "Date: 2026-09-04\nTOTAL ₱1,234.56\nPayment: GCASH";
    const bytes = new TextEncoder().encode(text).buffer;
    const result = await adapter.extract(bytes, "text/plain");
    expect(result.totalAmountCandidate?.value).toBe("1234.56");
    expect(result.currencyCandidate?.value).toBe("PHP");
    expect(result.paymentMethodCandidate?.value).toBe("GCASH");
    expect(result.dateCandidate?.value).toBe("2026-09-04");
  });

  it("does not throw on empty input", async () => {
    const result = await adapter.extract(new Uint8Array([]).buffer, "text/plain");
    expect(result.totalAmountCandidate).toBeUndefined();
    expect(result.dateCandidate).toBeUndefined();
  });
});
