/**
 * Deterministic post-OCR field extractor.
 *
 * Pipeline:
 *   image bytes → vision/OCR model → raw text → [parser] → candidate fields
 *
 * This module is the deterministic, testable extraction step. It produces
 * candidates only — it never posts financial transactions. Application
 * code is responsible for enforcing confidence thresholds and requiring
 * human confirmation before any OCR-derived financial write.
 *
 * See SPEC.md §12 and AGENTS.md §3.
 */

import type { OcrCandidateField, OcrExtractionResult } from "./interface.js";

export interface OcrParseOptions {
  /** Critical-field confidence below which the caller must require human review. */
  readonly criticalConfidenceThreshold?: number;
}

export const DEFAULT_CRITICAL_CONFIDENCE_THRESHOLD = 0.7;

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;

const CURRENCY_CODES = ["PHP", "USD", "EUR", "GBP", "JPY", "HKD", "SGD", "AUD", "CAD"] as const;
type CurrencyCode = (typeof CURRENCY_CODES)[number];

const CURRENCY_SYMBOL_TO_CODE: Record<string, CurrencyCode> = {
  "₱": "PHP",
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};

const CURRENCY_TOKEN_GROUP = `(?:${CURRENCY_CODES.join("|")}|\\$|₱|€|£|¥)`;

const RE_AMOUNT_LABELED = new RegExp(
  `\\b(?:GRAND\\s+TOTAL|TOTAL\\s+DUE|BALANCE\\s+DUE|AMOUNT\\s+DUE|TOTAL)\\b\\s*[:=]?\\s*${CURRENCY_TOKEN_GROUP}?\\s*${NUM}`,
  "i"
);

// Blurred/garbled TOTAL label patterns seen in OCR output: "T_TAL", "T.TAL", bare "TAL".
const RE_AMOUNT_BLURRED = new RegExp(
  `\\b(?:T[_\\.\\s]*TAL|TAL)\\s*[:=]?\\s*${CURRENCY_TOKEN_GROUP}?\\s*${NUM}`,
  "i"
);

const RE_LINE_NUM = new RegExp(`\\b${NUM}\\b`, "g");

const SUBTOTAL_LINE_PATTERN = /\b(?:SUB\s*TOTAL|SUBTOTAL)\b/i;
const TAX_LINE_PATTERN = /\b(?:VAT|TAX|GST)\b/i;

const RE_ISO_DATE = new RegExp(`\\b(\\d{4})-(\\d{2})-(\\d{2})\\b`);
const RE_SLASH_DATE = new RegExp(`\\b(\\d{1,2})/(\\d{1,2})/(\\d{4})\\b`);
const RE_DASH_DATE = new RegExp(`\\b(\\d{1,2})-(\\d{1,2})-(\\d{4})\\b`);
const RE_MONTH_NAME_DATE = new RegExp(
  `\\b(January|February|March|April|May|June|July|August|September|October|November|December|\\bJan|\\bFeb|\\bMar|\\bApr|\\bJun|\\bJul|\\bAug|\\bSep|\\bSept|\\bOct|\\bNov|\\bDec)\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`,
  "i"
);

const RE_CURRENCY_CODE = new RegExp(`\\b(${CURRENCY_CODES.join("|")})\\b`);

const RE_LAST4_ASTERISK = /\*{2,4}(\d{4})\b/;
const RE_LAST4_ENDING = /(?:ending\s*(?:in)?\s*|card\s*[:.]?\s*)(\d{4})\b/i;

const PAYMENT_METHOD_RULES: ReadonlyArray<{ pattern: RegExp; value: string }> = [
  { pattern: /\bCASH\b/i, value: "CASH" },
  { pattern: /\bGCASH\b/i, value: "GCASH" },
  { pattern: /\bPAYMAYA\b/i, value: "PAYMAYA" },
  { pattern: /\bMASTERCARD\b/i, value: "CARD" },
  { pattern: /\bVISA\b/i, value: "CARD" },
  { pattern: /\bDEBIT\s*CARD\b/i, value: "DEBIT_CARD" },
  { pattern: /\bCREDIT\s*CARD\b/i, value: "CREDIT_CARD" },
  { pattern: /\bDEBIT\b/i, value: "DEBIT" },
  { pattern: /\bCREDIT\b/i, value: "CREDIT" },
  { pattern: /\bCARD\b/i, value: "CARD" },
  { pattern: /\bBANK\s*TRANSFER\b/i, value: "BANK_TRANSFER" },
  { pattern: /\bCHEQUE\b/i, value: "CHEQUE" },
  { pattern: /\bCHECK\b/i, value: "CHEQUE" },
];

const MONTH_NAME_TO_NUMBER: Record<string, string> = {
  january: "01",
  jan: "01",
  february: "02",
  feb: "02",
  march: "03",
  mar: "03",
  april: "04",
  apr: "04",
  may: "05",
  june: "06",
  jun: "06",
  july: "07",
  jul: "07",
  august: "08",
  aug: "08",
  september: "09",
  sep: "09",
  sept: "09",
  october: "10",
  oct: "10",
  november: "11",
  nov: "11",
  december: "12",
  dec: "12",
};

function isSeparatorLine(line: string): boolean {
  return /^[\s=*\-_~]+$/.test(line);
}

function parseAmountNumber(raw: string): number | undefined {
  const cleaned = raw.replace(/,/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeAmount(raw: string): string {
  return raw.replace(/,/g, "");
}

function hasDecimal(raw: string): boolean {
  return raw.includes(".");
}

function extractTotalAmount(lines: readonly string[]): OcrCandidateField | undefined {
  for (const line of lines) {
    const m = RE_AMOUNT_LABELED.exec(line);
    if (m && m[1] !== undefined) {
      return { value: normalizeAmount(m[1]), confidence: 0.95 };
    }
  }

  for (const line of lines) {
    const m = RE_AMOUNT_BLURRED.exec(line);
    if (m && m[1] !== undefined) {
      return { value: normalizeAmount(m[1]), confidence: 0.92 };
    }
  }

  let bestValue = -Infinity;
  let bestRaw = "";
  let ambiguous = false;

  for (const line of lines) {
    if (SUBTOTAL_LINE_PATTERN.test(line)) continue;
    if (TAX_LINE_PATTERN.test(line)) continue;

    for (const match of line.matchAll(RE_LINE_NUM)) {
      const raw = match[0];
      if (raw === undefined) continue;
      if (!hasDecimal(raw)) continue;
      const value = parseAmountNumber(raw);
      if (value === undefined) continue;

      if (value > bestValue) {
        bestValue = value;
        bestRaw = raw;
        ambiguous = false;
      } else if (value === bestValue) {
        ambiguous = true;
      }
    }
  }

  if (bestValue === -Infinity) return undefined;
  return {
    value: normalizeAmount(bestRaw),
    confidence: ambiguous ? 0.5 : 0.6,
  };
}

function monthNameToNumber(name: string): string | undefined {
  return MONTH_NAME_TO_NUMBER[name.toLowerCase()];
}

/**
 * Disambiguate a two-part numeric date.
 *  - If partA > 12, partA must be a day (DD/MM/YYYY).
 *  - If partB > 12, partA must be a month (MM/DD/YYYY).
 *  - If both <= 12, default to DD/MM/YYYY (PH locale) but lower confidence.
 * Returns null if the combination is impossible.
 */
function interpretNumericDate(
  partA: string,
  partB: string,
  year: string
): { value: string; confidence: number } | null {
  const a = Number.parseInt(partA, 10);
  const b = Number.parseInt(partB, 10);
  const y = Number.parseInt(year, 10);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(y)) return null;
  if (a < 1 || a > 31 || b < 1 || b > 31) return null;

  if (a > 12 && b <= 12) {
    return { value: `${year}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`, confidence: 0.9 };
  }
  if (b > 12 && a <= 12) {
    return { value: `${year}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`, confidence: 0.9 };
  }
  if (a <= 12 && b <= 12) {
    return { value: `${year}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`, confidence: 0.65 };
  }
  return null;
}

function extractDate(text: string): OcrCandidateField | undefined {
  const iso = RE_ISO_DATE.exec(text);
  if (iso && iso[1] && iso[2] && iso[3]) {
    return { value: `${iso[1]}-${iso[2]}-${iso[3]}`, confidence: 0.95 };
  }

  const monthName = RE_MONTH_NAME_DATE.exec(text);
  if (monthName && monthName[1] && monthName[2] && monthName[3]) {
    const monthNum = monthNameToNumber(monthName[1]);
    if (monthNum !== undefined) {
      const day = monthName[2].padStart(2, "0");
      return { value: `${monthName[3]}-${monthNum}-${day}`, confidence: 0.9 };
    }
  }

  const dash = RE_DASH_DATE.exec(text);
  if (dash && dash[1] && dash[2] && dash[3]) {
    const interpreted = interpretNumericDate(dash[1], dash[2], dash[3]);
    if (interpreted) return interpreted;
  }

  const slash = RE_SLASH_DATE.exec(text);
  if (slash && slash[1] && slash[2] && slash[3]) {
    const interpreted = interpretNumericDate(slash[1], slash[2], slash[3]);
    if (interpreted) return interpreted;
  }

  return undefined;
}

const SKIP_MERCHANT_PREFIXES: readonly RegExp[] = [
  /^(date|invoice|receipt|order|bill|ref|customer|table|server|cashier)\b/i,
  /^(sub\s*total|subtotal|total|amount|balance|payment|paid|tendered|change)\b/i,
  /^(vat|tax|gst)\b/i,
  /^(thank|merci|salamat)\b/i,
  /^\d+$/,
];

function extractMerchant(lines: readonly string[]): OcrCandidateField | undefined {
  for (const line of lines) {
    if (line.length < 3) continue;
    if (isSeparatorLine(line)) continue;
    if (SKIP_MERCHANT_PREFIXES.some((p) => p.test(line))) continue;
    return { value: line, confidence: 0.8 };
  }
  return undefined;
}

function extractCurrency(text: string): OcrCandidateField | undefined {
  const codeMatch = RE_CURRENCY_CODE.exec(text);
  if (codeMatch && codeMatch[1]) {
    return { value: codeMatch[1], confidence: 0.95 };
  }
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOL_TO_CODE)) {
    if (text.includes(symbol)) {
      return { value: code, confidence: 0.85 };
    }
  }
  return undefined;
}

function extractPaymentMethod(lines: readonly string[]): OcrCandidateField | undefined {
  for (const line of lines) {
    for (const rule of PAYMENT_METHOD_RULES) {
      if (rule.pattern.test(line)) {
        return { value: rule.value, confidence: 0.9 };
      }
    }
  }
  return undefined;
}

function extractTax(lines: readonly string[]): OcrCandidateField | undefined {
  for (const line of lines) {
    if (!TAX_LINE_PATTERN.test(line)) continue;
    for (const m of line.matchAll(/(\d{1,3}(?:,\d{3})*\.\d{1,2})/g)) {
      const raw = m[1];
      if (raw === undefined) continue;
      const numEnd = (m.index ?? 0) + raw.length;
      if (line.charAt(numEnd) === "%") continue;
      return { value: normalizeAmount(raw), confidence: 0.9 };
    }
    for (const m of line.matchAll(/\b(\d{2,})\b/g)) {
      const raw = m[1];
      if (raw === undefined) continue;
      const numEnd = (m.index ?? 0) + raw.length;
      if (line.charAt(numEnd) === "%") continue;
      return { value: raw, confidence: 0.85 };
    }
  }
  return undefined;
}

function extractLast4(text: string): OcrCandidateField | undefined {
  const asterisk = RE_LAST4_ASTERISK.exec(text);
  if (asterisk && asterisk[1]) {
    return { value: asterisk[1], confidence: 0.95 };
  }
  const ending = RE_LAST4_ENDING.exec(text);
  if (ending && ending[1]) {
    return { value: ending[1], confidence: 0.85 };
  }
  return undefined;
}

/**
 * Parse raw OCR text into candidate fields.
 *
 * Pure function: deterministic, no side effects, no I/O.
 * Never posts financial transactions.
 */
export function parseOcrText(rawText: string, _options: OcrParseOptions = {}): OcrExtractionResult {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const total = extractTotalAmount(lines);
  const date = extractDate(rawText);
  const merchant = extractMerchant(lines);
  const currency = extractCurrency(rawText);
  const payment = extractPaymentMethod(lines);
  const tax = extractTax(lines);
  const last4 = extractLast4(rawText);

  return {
    rawText,
    processingMs: 0,
    ...(total && { totalAmountCandidate: total }),
    ...(date && { dateCandidate: date }),
    ...(merchant && { merchantCandidate: merchant }),
    ...(currency && { currencyCandidate: currency }),
    ...(payment && { paymentMethodCandidate: payment }),
    ...(tax && { taxAmountCandidate: tax }),
    ...(last4 && { last4Candidate: last4 }),
  };
}
