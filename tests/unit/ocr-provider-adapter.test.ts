/**
 * ocr-provider-adapter.test.ts
 *
 * Unit tests for the provider-backed OCR adapter seam (SPEC.md §12).
 *
 * Verifies:
 *  - MockOcrProvider decodes image bytes → text deterministically;
 *  - ProviderOcrAdapter calls the provider boundary and parses the
 *    returned text via the same parser used by HeuristicOcrAdapter;
 *  - The provider seam is injectable and swappable (any conforming
 *    OcrProvider works);
 *  - ProviderOcrAdapter returns candidate fields only, never a posted
 *    transaction, transaction id, balance change, or ledger entry;
 *  - Records processingMs latency.
 */

import { describe, it, expect } from "vitest";
import { MockOcrProvider, ProviderOcrAdapter, decideOcrReview } from "../../src/adapters/ocr/index.js";
import type { OcrProvider } from "../../src/adapters/ocr/index.js";

describe("MockOcrProvider", () => {
  it("decodes image bytes back into the original UTF-8 text", async () => {
    const provider = new MockOcrProvider();
    const text = "ACME\nDate: 2026-08-15\nTOTAL 100.00 PHP";
    const bytes = new TextEncoder().encode(text).buffer;
    const result = await provider.extractText(bytes, "image/png");
    expect(result.text).toBe(text);
  });

  it("ignores the mime type (deterministic fixture contract)", async () => {
    const provider = new MockOcrProvider();
    const bytes = new TextEncoder().encode("TOTAL 50.00").buffer;
    expect((await provider.extractText(bytes, "image/png")).text).toBe("TOTAL 50.00");
    expect((await provider.extractText(bytes, "image/jpeg")).text).toBe("TOTAL 50.00");
    expect((await provider.extractText(bytes, "application/pdf")).text).toBe("TOTAL 50.00");
  });

  it("decodes UTF-8 multibyte sequences (peso sign, accents)", async () => {
    const provider = new MockOcrProvider();
    const text = "TOTAL ₱1,234.56 — Café";
    const bytes = new TextEncoder().encode(text).buffer;
    expect((await provider.extractText(bytes, "image/png")).text).toBe(text);
  });
});

describe("ProviderOcrAdapter", () => {
  const adapter = new ProviderOcrAdapter(new MockOcrProvider());

  it("extracts the same candidate fields as the deterministic parser", async () => {
    const text = "SM GROCERY\nDate: 2026-08-15\nTOTAL 302.40 PHP\nPayment: CASH";
    const bytes = new TextEncoder().encode(text).buffer;
    const result = await adapter.extract(bytes, "image/png");
    expect(result.totalAmountCandidate?.value).toBe("302.40");
    expect(result.currencyCandidate?.value).toBe("PHP");
    expect(result.dateCandidate?.value).toBe("2026-08-15");
    expect(result.paymentMethodCandidate?.value).toBe("CASH");
  });

  it("never returns a posted transaction or balance", async () => {
    const text = "TOTAL 100.00 PHP";
    const result = await adapter.extract(new TextEncoder().encode(text).buffer, "image/png");
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

  it("records non-negative finite processingMs latency", async () => {
    const text = "TOTAL 100.00";
    const result = await adapter.extract(new TextEncoder().encode(text).buffer, "image/png");
    expect(result.processingMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.processingMs)).toBe(true);
  });

  it("accepts any conforming OcrProvider (swappable production seam)", async () => {
    const altProvider: OcrProvider = {
      extractText: async (): Promise<{ text: string }> => {
        return { text: "Date: 2026-08-15\nTOTAL 42.00 USD" };
      },
    };
    const altAdapter = new ProviderOcrAdapter(altProvider);
    const result = await altAdapter.extract(new Uint8Array([]).buffer, "image/png");
    expect(result.totalAmountCandidate?.value).toBe("42.00");
    expect(result.currencyCandidate?.value).toBe("USD");
  });

  it("propagates provider errors so callers never silently auto-post", async () => {
    const failingProvider: OcrProvider = {
      extractText: async (): Promise<{ text: string }> => {
        throw new Error("provider unavailable");
      },
    };
    const failingAdapter = new ProviderOcrAdapter(failingProvider);
    await expect(failingAdapter.extract(new Uint8Array([]).buffer, "image/png")).rejects.toThrow(
      /provider unavailable/
    );
  });

  it("high-confidence extraction passes the review gate", async () => {
    const text = "Date: 2026-08-15\nTOTAL 100.00 PHP";
    const result = await adapter.extract(new TextEncoder().encode(text).buffer, "image/png");
    const decision = decideOcrReview(result);
    expect(decision.requiresReview).toBe(false);
  });

  it("missing critical fields require review (no auto-post)", async () => {
    const text = "ACME STORE\nno totals or dates here";
    const result = await adapter.extract(new TextEncoder().encode(text).buffer, "image/png");
    const decision = decideOcrReview(result);
    expect(decision.requiresReview).toBe(true);
  });
});
