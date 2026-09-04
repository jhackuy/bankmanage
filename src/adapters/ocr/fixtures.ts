/**
 * Synthetic OCR benchmark fixtures.
 *
 * 24 anonymized representative receipt/deposit documents used by the M3
 * benchmark harness. All amounts, dates, merchant names, card numbers and
 * identifiers are obviously synthetic — no real family data.
 *
 * Each fixture carries:
 *  - `text`: UTF-8 ground-truth OCR text (used by the deterministic parser
 *    and by the mock provider to simulate OCR output from image bytes)
 *  - `imageBytes`: synthetic image bytes that a mock OCR provider decodes
 *    back into `text`. The production provider path receives these bytes;
 *    the mock provider boundary in `provider.ts` decodes them.
 *
 * Categories cover SPEC.md §12 failure modes:
 *   clean, blur, glare, crop, rotation, multilingual
 */

import type { OcrBenchmarkFixture } from "./benchmark.js";

export function synthesizeImageBytes(text: string): ArrayBuffer {
  const enc = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(enc.byteLength);
  new Uint8Array(buf).set(enc);
  return buf;
}

interface RawFixture {
  readonly id: string;
  readonly category: "clean" | "blur" | "glare" | "crop" | "rotation" | "multilingual";
  readonly text: string;
  readonly groundTruth: {
    readonly amount?: string;
    readonly date?: string;
    readonly currency?: string;
    readonly merchant?: string;
    readonly paymentMethod?: string;
    readonly taxAmount?: string;
    readonly last4?: string;
  };
}

const RAW_FIXTURES: readonly RawFixture[] = [
  // ---- clean (8 fixtures) ----
  {
    id: "receipt-clean-001-grocery-php",
    category: "clean",
    text: [
      "SM GROCERY MART",
      "123 Main Street, Manila",
      "Date: 2026-08-15",
      "--------------------------------",
      "Milk              85.00",
      "Bread             65.00",
      "Eggs              120.00",
      "--------------------------------",
      "Subtotal         270.00",
      "VAT (12%)         32.40",
      "--------------------------------",
      "TOTAL             302.40 PHP",
      "",
      "Payment: CASH",
      "--------------------------------",
      "Thank you for shopping!",
    ].join("\n"),
    groundTruth: {
      amount: "302.40",
      date: "2026-08-15",
      currency: "PHP",
      merchant: "SM GROCERY MART",
      paymentMethod: "CASH",
      taxAmount: "32.40",
    },
  },
  {
    id: "receipt-clean-002-restaurant-usd",
    category: "clean",
    text: [
      "LE CELLIER STEAKHOUSE",
      "Orlando, FL",
      "Date: August 20, 2026",
      "--------------------------------",
      "Filet Mignon    48.00",
      "Wine            32.00",
      "Tip suggested",
      "--------------------------------",
      "TOTAL           80.00 USD",
      "Paid by VISA ****4242",
    ].join("\n"),
    groundTruth: {
      amount: "80.00",
      date: "2026-08-20",
      currency: "USD",
      merchant: "LE CELLIER STEAKHOUSE",
      paymentMethod: "CARD",
      last4: "4242",
    },
  },
  {
    id: "receipt-clean-003-utility-php",
    category: "clean",
    text: [
      "MANILA ELECTRIC COMPANY",
      "MERALCO",
      "Statement Date: 2026-09-01",
      "--------------------------------",
      "Electric Charges  2150.75",
      "--------------------------------",
      "TOTAL DUE         2150.75 PHP",
      "Payment Method: GCASH",
    ].join("\n"),
    groundTruth: {
      amount: "2150.75",
      date: "2026-09-01",
      currency: "PHP",
      merchant: "MANILA ELECTRIC COMPANY",
      paymentMethod: "GCASH",
    },
  },
  {
    id: "receipt-clean-004-fuel-eur",
    category: "clean",
    text: [
      "SHELL PETROL STATION",
      "London, UK",
      "Date: 2026-07-14",
      "--------------------------------",
      "Diesel         55.40",
      "--------------------------------",
      "TOTAL          55.40 GBP",
      "Paid by DEBIT CARD ****1881",
    ].join("\n"),
    groundTruth: {
      amount: "55.40",
      date: "2026-07-14",
      currency: "GBP",
      merchant: "SHELL PETROL STATION",
      paymentMethod: "DEBIT_CARD",
      last4: "1881",
    },
  },
  {
    id: "receipt-clean-005-pharmacy-php",
    category: "clean",
    text: [
      "MERCURY DRUG CORPORATION",
      "Makati City",
      "Date: September 3, 2026",
      "--------------------------------",
      "Paracetamol     45.00",
      "Vitamin C      180.00",
      "--------------------------------",
      "TOTAL          225.00 PHP",
      "Payment: CASH",
    ].join("\n"),
    groundTruth: {
      amount: "225.00",
      date: "2026-09-03",
      currency: "PHP",
      merchant: "MERCURY DRUG CORPORATION",
      paymentMethod: "CASH",
    },
  },
  {
    id: "receipt-clean-006-deposit-cert-php",
    category: "clean",
    text: [
      "BDO TERM DEPOSIT ADVICE",
      "Certificate No: ****7891",
      "Date: 2026-08-30",
      "--------------------------------",
      "Principal   100000.00 PHP",
      "--------------------------------",
      "Maturity Amount 100986.30 PHP",
      "Interest Method: SIMPLE",
    ].join("\n"),
    groundTruth: {
      amount: "100986.30",
      date: "2026-08-30",
      currency: "PHP",
      merchant: "BDO TERM DEPOSIT ADVICE",
      last4: "7891",
    },
  },
  {
    id: "receipt-clean-007-supermarket-php",
    category: "clean",
    text: [
      "PUREGOLD PRICE CLUB",
      "Quezon City",
      "Date: 08/25/2026",
      "--------------------------------",
      "Rice 5kg        285.00",
      "Chicken 1kg     220.00",
      "Vegetables       95.00",
      "--------------------------------",
      "TOTAL           600.00 PHP",
      "Payment: CASH",
    ].join("\n"),
    groundTruth: {
      amount: "600.00",
      date: "2026-08-25",
      currency: "PHP",
      merchant: "PUREGOLD PRICE CLUB",
      paymentMethod: "CASH",
    },
  },
  {
    id: "receipt-clean-008-hardware-jpy",
    category: "clean",
    text: [
      "HARDWARE STORE TOKYO",
      "Shinjuku, Japan",
      "Date: 2026-06-12",
      "--------------------------------",
      "Tools           4800",
      "--------------------------------",
      "TOTAL          4800 JPY",
      "Paid by CREDIT CARD ****0033",
    ].join("\n"),
    groundTruth: {
      amount: "4800",
      date: "2026-06-12",
      currency: "JPY",
      merchant: "HARDWARE STORE TOKYO",
      paymentMethod: "CREDIT_CARD",
      last4: "0033",
    },
  },

  // ---- blur (5 fixtures, missing characters) ----
  {
    id: "receipt-blur-001-grocery",
    category: "blur",
    text: [
      "SM GROCERY  MART",
      "123 Ma_n Street, Manila",
      "Date: 2026-08-15",
      "--------------------------------",
      "Milk              85.00",
      "Bread             65.00",
      "Eggs              120.00",
      "--------------------------------",
      "Subtotal         270.00",
      "VAT (12%)         32.40",
      "--------------------------------",
      "T_TAL             302.40 PHP",
      "",
      "Payment: CASH",
    ].join("\n"),
    groundTruth: {
      amount: "302.40",
      date: "2026-08-15",
      currency: "PHP",
      paymentMethod: "CASH",
      taxAmount: "32.40",
    },
  },
  {
    id: "receipt-blur-002-restaurant",
    category: "blur",
    text: [
      "LE CELLIER  STEAKHOUSE",
      "Orlando, FL",
      "Date: August 20, 2026",
      "--------------------------------",
      "Filet Mignon    48.00",
      "Wine            32.00",
      "--------------------------------",
      "T_TAL           80.00 USD",
      "Paid by VISA ****4242",
    ].join("\n"),
    groundTruth: {
      amount: "80.00",
      date: "2026-08-20",
      currency: "USD",
      paymentMethod: "CARD",
      last4: "4242",
    },
  },
  {
    id: "receipt-blur-003-pharmacy",
    category: "blur",
    text: [
      "MERCURY  DRUG CORPORATION",
      "Makati City",
      "Date: September 3, 2026",
      "--------------------------------",
      "Paracetamol     45.00",
      "Vitamin C      180.00",
      "--------------------------------",
      "AM_UN DUE       225.00 PHP",
      "Payment: CASH",
    ].join("\n"),
    groundTruth: {
      amount: "225.00",
      date: "2026-09-03",
      currency: "PHP",
      paymentMethod: "CASH",
    },
  },
  {
    id: "receipt-blur-004-fuel",
    category: "blur",
    text: [
      "SHELL  PETROL STATION",
      "London, UK",
      "Date: 2026-07-14",
      "--------------------------------",
      "Diesel         55.40",
      "--------------------------------",
      "TAL            55.40 GBP",
      "Paid by DEBIT CARD ****1881",
    ].join("\n"),
    groundTruth: {
      amount: "55.40",
      date: "2026-07-14",
      currency: "GBP",
      last4: "1881",
    },
  },
  {
    id: "receipt-blur-005-supermarket",
    category: "blur",
    text: [
      "PUREGOLD PRICE  CLUB",
      "Quezon City",
      "Date: 08/25/2026",
      "--------------------------------",
      "Rice 5kg        285.00",
      "Chicken 1kg     220.00",
      "Vegetables       95.00",
      "--------------------------------",
      "TAL             600.00 PHP",
      "Payment: CASH",
    ].join("\n"),
    groundTruth: {
      amount: "600.00",
      date: "2026-08-25",
      currency: "PHP",
      paymentMethod: "CASH",
    },
  },

  // ---- glare (3 fixtures, extra noise characters) ----
  {
    id: "receipt-glare-001-grocery",
    category: "glare",
    text: [
      "  S M   G R O C E R Y  M A R T  ",
      " 123 Main Street , Manila ",
      "Date :  2026-08-15",
      "--------------------------------",
      "Milk              85.00",
      "Bread             65.00",
      "Eggs              120.00",
      "--------------------------------",
      "TOTAL            302.40  PHP",
      "Payment: CASH",
    ].join("\n"),
    groundTruth: {
      amount: "302.40",
      date: "2026-08-15",
      currency: "PHP",
      paymentMethod: "CASH",
    },
  },
  {
    id: "receipt-glare-002-utility",
    category: "glare",
    text: [
      "M A N I L A   E L E C T R I C  CO",
      "Meralco",
      "Statement Date :  2026-09-01",
      "--------------------------------",
      "Electric Charges  2150.75",
      "--------------------------------",
      "TOTAL DUE         2150.75 PHP",
      "Payment Method: GCASH",
    ].join("\n"),
    groundTruth: {
      amount: "2150.75",
      date: "2026-09-01",
      currency: "PHP",
      paymentMethod: "GCASH",
    },
  },
  {
    id: "receipt-glare-003-hardware",
    category: "glare",
    text: [
      "H A R D W A R E   S T O R E   T",
      "Tokyo, Japan",
      "Date: 2026-06-12",
      "--------------------------------",
      "Tools           4800",
      "--------------------------------",
      "TOTAL          4800  JPY",
      "Paid by CREDIT CARD ****0033",
    ].join("\n"),
    groundTruth: {
      amount: "4800",
      date: "2026-06-12",
      currency: "JPY",
      paymentMethod: "CREDIT_CARD",
      last4: "0033",
    },
  },

  // ---- crop (3 fixtures, last lines missing) ----
  {
    id: "receipt-crop-001-pharmacy",
    category: "crop",
    text: [
      "MERCURY DRUG CORPORATION",
      "Makati City",
      "Date: September 3, 2026",
      "--------------------------------",
      "Paracetamol     45.00",
      "Vitamin C      180.00",
    ].join("\n"),
    groundTruth: {
      date: "2026-09-03",
      merchant: "MERCURY DRUG CORPORATION",
    },
  },
  {
    id: "receipt-crop-002-fuel",
    category: "crop",
    text: [
      "SHELL PETROL STATION",
      "London, UK",
      "Date: 2026-07-14",
      "--------------------------------",
      "Diesel         55.40",
      "--------------------------------",
      "TOTAL          55.40 GBP",
    ].join("\n"),
    groundTruth: {
      amount: "55.40",
      date: "2026-07-14",
      currency: "GBP",
    },
  },
  {
    id: "receipt-crop-003-supermarket",
    category: "crop",
    text: [
      "PUREGOLD PRICE CLUB",
      "Quezon City",
      "Date: 08/25/2026",
      "--------------------------------",
      "Rice 5kg        285.00",
      "Chicken 1kg     220.00",
      "Vegetables       95.00",
    ].join("\n"),
    groundTruth: {
      date: "2026-08-25",
      merchant: "PUREGOLD PRICE CLUB",
    },
  },

  // ---- rotation (2 fixtures, label and amount on the same line but rotated layout) ----
  {
    id: "receipt-rotation-001-grocery",
    category: "rotation",
    text: [
      "====",
      "Date: 2026-08-15",
      "  Milk 85.00 Bread 65.00 Eggs 120.00",
      "====",
      "  Subtotal 270.00",
      "  VAT 32.40",
      "  TOTAL 302.40 PHP",
      "  Payment: CASH",
      "====",
    ].join("\n"),
    groundTruth: {
      amount: "302.40",
      date: "2026-08-15",
      currency: "PHP",
      paymentMethod: "CASH",
      taxAmount: "32.40",
    },
  },
  {
    id: "receipt-rotation-002-restaurant",
    category: "rotation",
    text: [
      "====",
      "Date: August 20, 2026",
      "  Filet 48.00 Wine 32.00",
      "====",
      "  TOTAL 80.00 USD",
      "  Paid VISA ****4242",
      "====",
    ].join("\n"),
    groundTruth: {
      amount: "80.00",
      date: "2026-08-20",
      currency: "USD",
      paymentMethod: "CARD",
      last4: "4242",
    },
  },

  // ---- multilingual (3 fixtures, mixed English + Filipino) ----
  {
    id: "receipt-multilingual-001-sari-sari",
    category: "multilingual",
    text: [
      "ALING NENA'S SARI-SARI STORE",
      "Date: 2026-08-15",
      "--------------------------------",
      "Bigas 5kg       285.00",
      "Itlog           120.00",
      "Sardinas         45.00",
      "--------------------------------",
      "TOTAL          450.00 PHP",
      "Bayad: CASH",
      "Salamat po!",
    ].join("\n"),
    groundTruth: {
      amount: "450.00",
      date: "2026-08-15",
      currency: "PHP",
      merchant: "ALING NENA'S SARI-SARI STORE",
      paymentMethod: "CASH",
    },
  },
  {
    id: "receipt-multilingual-002-carinderia",
    category: "multilingual",
    text: [
      "MANANG CARINDERIA",
      "Date: September 1, 2026",
      "--------------------------------",
      "Tapsilog        85.00",
      "Tocilog         95.00",
      "--------------------------------",
      "TOTAL          180.00 PHP",
      "Payment: CASH",
      "Salamat sa pagbili!",
    ].join("\n"),
    groundTruth: {
      amount: "180.00",
      date: "2026-09-01",
      currency: "PHP",
      merchant: "MANANG CARINDERIA",
      paymentMethod: "CASH",
    },
  },
  {
    id: "receipt-multilingual-003-palengke",
    category: "multilingual",
    text: [
      "PALENGKE FRESH MARKET",
      "Petsa: 2026-07-20",
      "--------------------------------",
      "Prutas          150.00",
      "Gulay            80.00",
      "Isda            220.00",
      "--------------------------------",
      "TOTAL          450.00 PHP",
      "Bayad: CASH",
    ].join("\n"),
    groundTruth: {
      amount: "450.00",
      date: "2026-07-20",
      currency: "PHP",
      paymentMethod: "CASH",
    },
  },
];

export const OCR_BENCHMARK_FIXTURES: readonly OcrBenchmarkFixture[] = RAW_FIXTURES.map(
  (f): OcrBenchmarkFixture => ({
    id: f.id,
    category: f.category,
    text: f.text,
    imageBytes: synthesizeImageBytes(f.text),
    groundTruth: f.groundTruth,
  })
);

export const OCR_BENCHMARK_MIN_FIXTURES = 20;
