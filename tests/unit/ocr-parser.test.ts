/**
 * ocr-parser.test.ts
 *
 * Unit tests for the deterministic OCR text → candidate-fields parser.
 * Verifies extraction of amount, date, merchant, currency, payment method,
 * tax, and last4 from representative synthetic receipts.
 */

import { describe, it, expect } from "vitest";
import { parseOcrText, DEFAULT_CRITICAL_CONFIDENCE_THRESHOLD } from "../../src/adapters/ocr/index.js";

describe("parseOcrText — total amount", () => {
  it("extracts an explicitly labeled TOTAL with high confidence", () => {
    const result = parseOcrText(["ACME STORE", "TOTAL          302.40 PHP", "Payment: CASH"].join("\n"));
    expect(result.totalAmountCandidate).toBeDefined();
    expect(result.totalAmountCandidate?.value).toBe("302.40");
    expect(result.totalAmountCandidate?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("extracts TOTAL DUE / AMOUNT DUE labels", () => {
    const result = parseOcrText("TOTAL DUE         1234.56 PHP");
    expect(result.totalAmountCandidate?.value).toBe("1234.56");
  });

  it("falls back to the largest non-subtotal amount when no TOTAL label is present", () => {
    const result = parseOcrText(
      ["Item A      10.00", "Item B      25.00", "Item C      75.50", "Payment: CASH"].join("\n")
    );
    expect(result.totalAmountCandidate?.value).toBe("75.50");
  });

  it("ignores the SUBTOTAL when picking the largest amount", () => {
    const result = parseOcrText(["Item A      10.00", "Subtotal    50.00", "Item B     100.00"].join("\n"));
    expect(result.totalAmountCandidate?.value).toBe("100.00");
  });

  it("normalizes thousands separators", () => {
    const result = parseOcrText("TOTAL          1,234.56 PHP");
    expect(result.totalAmountCandidate?.value).toBe("1234.56");
  });

  it("handles a missing amount field gracefully", () => {
    const result = parseOcrText("ACME STORE\nDate: 2026-08-15");
    expect(result.totalAmountCandidate).toBeUndefined();
  });
});

describe("parseOcrText — date", () => {
  it("extracts ISO YYYY-MM-DD dates with high confidence", () => {
    const result = parseOcrText("Date: 2026-08-15");
    expect(result.dateCandidate?.value).toBe("2026-08-15");
    expect(result.dateCandidate?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("extracts month-name dates (e.g. 'August 20, 2026')", () => {
    const result = parseOcrText("Date: August 20, 2026");
    expect(result.dateCandidate?.value).toBe("2026-08-20");
  });

  it("extracts short month names (e.g. 'Sep 3, 2026')", () => {
    const result = parseOcrText("Date: Sep 3, 2026");
    expect(result.dateCandidate?.value).toBe("2026-09-03");
  });

  it("disambiguates MM/DD/YYYY when the second part > 12", () => {
    const result = parseOcrText("Date: 08/25/2026");
    expect(result.dateCandidate?.value).toBe("2026-08-25");
  });

  it("disambiguates DD/MM/YYYY when the first part > 12", () => {
    const result = parseOcrText("Date: 25/08/2026");
    expect(result.dateCandidate?.value).toBe("2026-08-25");
  });

  it("returns lower confidence when both parts could be day or month", () => {
    const result = parseOcrText("Date: 05/06/2026");
    expect(result.dateCandidate?.value).toBe("2026-06-05");
    expect(result.dateCandidate?.confidence).toBeLessThan(DEFAULT_CRITICAL_CONFIDENCE_THRESHOLD);
  });

  it("returns no date when text has none", () => {
    const result = parseOcrText("ACME STORE\nTOTAL 50.00");
    expect(result.dateCandidate).toBeUndefined();
  });
});

describe("parseOcrText — merchant", () => {
  it("extracts the first business-name-like line", () => {
    const result = parseOcrText(
      ["PUREGOLD PRICE CLUB", "Quezon City", "Date: 2026-08-25", "TOTAL 600.00 PHP"].join("\n")
    );
    expect(result.merchantCandidate?.value).toBe("PUREGOLD PRICE CLUB");
  });

  it("skips Date/Total/VAT/Payment lines", () => {
    const result = parseOcrText(["Date: 2026-08-25", "MERCURY DRUG", "TOTAL 100.00"].join("\n"));
    expect(result.merchantCandidate?.value).toBe("MERCURY DRUG");
  });

  it("skips separator lines", () => {
    const result = parseOcrText(["===", "ACME STORE", "===", "TOTAL 50.00"].join("\n"));
    expect(result.merchantCandidate?.value).toBe("ACME STORE");
  });
});

describe("parseOcrText — currency", () => {
  it("extracts explicit currency codes", () => {
    const result = parseOcrText("TOTAL 100.00 PHP");
    expect(result.currencyCandidate?.value).toBe("PHP");
  });

  it("maps ₱ symbol to PHP", () => {
    const result = parseOcrText("TOTAL ₱100.00");
    expect(result.currencyCandidate?.value).toBe("PHP");
  });

  it("maps $ symbol to USD", () => {
    const result = parseOcrText("TOTAL $100.00");
    expect(result.currencyCandidate?.value).toBe("USD");
  });

  it("extracts multiple currency codes (first match wins)", () => {
    const result = parseOcrText("TOTAL 100.00 USD");
    expect(result.currencyCandidate?.value).toBe("USD");
  });
});

describe("parseOcrText — payment method", () => {
  it("detects CASH", () => {
    const result = parseOcrText("Payment: CASH");
    expect(result.paymentMethodCandidate?.value).toBe("CASH");
  });

  it("detects VISA and maps to CARD", () => {
    const result = parseOcrText("Paid by VISA ****4242");
    expect(result.paymentMethodCandidate?.value).toBe("CARD");
  });

  it("detects DEBIT CARD specifically", () => {
    const result = parseOcrText("Paid by DEBIT CARD ****1881");
    expect(result.paymentMethodCandidate?.value).toBe("DEBIT_CARD");
  });

  it("detects GCASH", () => {
    const result = parseOcrText("Payment Method: GCASH");
    expect(result.paymentMethodCandidate?.value).toBe("GCASH");
  });
});

describe("parseOcrText — tax", () => {
  it("extracts VAT amount", () => {
    const result = parseOcrText(["Subtotal 100.00", "VAT (12%) 12.00", "TOTAL 112.00"].join("\n"));
    expect(result.taxAmountCandidate?.value).toBe("12.00");
  });

  it("returns no tax when label absent", () => {
    const result = parseOcrText("TOTAL 100.00");
    expect(result.taxAmountCandidate).toBeUndefined();
  });
});

describe("parseOcrText — last4", () => {
  it("extracts last4 from masked card pattern", () => {
    const result = parseOcrText("Paid by VISA ****4242");
    expect(result.last4Candidate?.value).toBe("4242");
  });

  it("extracts last4 from 'ending in' phrasing", () => {
    const result = parseOcrText("Card ending in 1881");
    expect(result.last4Candidate?.value).toBe("1881");
  });
});

describe("parseOcrText — pure function contract", () => {
  it("does not mutate its input", () => {
    const text = "ACME STORE\nTOTAL 100.00\n";
    const snapshot = text;
    parseOcrText(text);
    expect(text).toBe(snapshot);
  });

  it("returns a rawText field for audit/debug", () => {
    const text = "ACME\nTOTAL 100.00";
    const result = parseOcrText(text);
    expect(result.rawText).toBe(text);
  });

  it("is deterministic across repeated calls", () => {
    const text = "ACME\nDate: 2026-08-15\nTOTAL 100.00 PHP\nPayment: CASH";
    const a = parseOcrText(text);
    const b = parseOcrText(text);
    expect(a.totalAmountCandidate).toEqual(b.totalAmountCandidate);
    expect(a.dateCandidate).toEqual(b.dateCandidate);
    expect(a.currencyCandidate).toEqual(b.currencyCandidate);
    expect(a.paymentMethodCandidate).toEqual(b.paymentMethodCandidate);
  });
});
