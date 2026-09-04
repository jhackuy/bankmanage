/**
 * Deterministic OCR benchmark harness.
 *
 * Runs an `OcrAdapter` over a synthetic fixture set and reports
 * correctness, latency and failure-mode metrics against SPEC.md §12
 * acceptance thresholds:
 *
 *   - amount correctness >= 95%
 *   - date correctness >= 90%
 *   - every incorrect critical result is intercepted by review (the
 *     adapter has no auto-post path; the gate lives in `confidence.ts`).
 *
 * The benchmark NEVER posts financial transactions. It only reports
 * metrics; the adapter is structurally read-only.
 */

import type { OcrAdapter, OcrExtractionResult } from "./interface.js";

export const AMOUNT_CORRECTNESS_THRESHOLD = 0.95;
export const DATE_CORRECTNESS_THRESHOLD = 0.9;

export type OcrBenchmarkCategory = "clean" | "blur" | "glare" | "crop" | "rotation" | "multilingual";

export interface OcrBenchmarkGroundTruth {
  readonly amount?: string;
  readonly date?: string;
  readonly currency?: string;
  readonly merchant?: string;
  readonly paymentMethod?: string;
  readonly taxAmount?: string;
  readonly last4?: string;
}

export interface OcrBenchmarkFixture {
  readonly id: string;
  readonly category: OcrBenchmarkCategory;
  /** UTF-8 text content of the synthetic document. */
  readonly text: string;
  readonly groundTruth: OcrBenchmarkGroundTruth;
}

export interface OcrBenchmarkRow {
  readonly fixtureId: string;
  readonly category: OcrBenchmarkCategory;
  readonly amountCorrect: boolean | null;
  readonly dateCorrect: boolean | null;
  readonly currencyCorrect: boolean | null;
  readonly merchantCorrect: boolean | null;
  readonly paymentMethodCorrect: boolean | null;
  readonly taxAmountCorrect: boolean | null;
  readonly last4Correct: boolean | null;
  readonly amountConfidence: number | null;
  readonly dateConfidence: number | null;
  readonly processingMs: number;
  /** Provider cost estimate in USD micro-units (0 for the synthetic benchmark). */
  readonly costEstimateMicroUsd: number;
  readonly error: string | null;
}

export interface OcrCategoryBreakdown {
  readonly count: number;
  readonly amountCorrectness: number;
  readonly dateCorrectness: number;
}

export interface OcrBenchmarkReport {
  readonly fixtureCount: number;
  readonly amountCorrectness: number;
  readonly dateCorrectness: number;
  readonly currencyCorrectness: number;
  readonly merchantCorrectness: number;
  readonly paymentMethodCorrectness: number;
  readonly taxAmountCorrectness: number;
  readonly last4Correctness: number;
  readonly amountThreshold: number;
  readonly dateThreshold: number;
  readonly amountThresholdMet: boolean;
  readonly dateThresholdMet: boolean;
  readonly averageProcessingMs: number;
  readonly maxProcessingMs: number;
  readonly totalCostEstimateMicroUsd: number;
  readonly failureModeBreakdown: Readonly<Record<OcrBenchmarkCategory, OcrCategoryBreakdown>>;
  readonly rows: readonly OcrBenchmarkRow[];
  readonly adapterDidPostFinancialTransaction: false;
}

export interface OcrBenchmarkResult {
  readonly report: OcrBenchmarkReport;
  readonly thresholdMet: boolean;
}

const AMOUNT_TOLERANCE = 0.01;

function compareAmounts(extracted: string | undefined, expected: string | undefined): boolean {
  if (extracted === undefined || expected === undefined) return false;
  const a = Number.parseFloat(extracted);
  const b = Number.parseFloat(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) < AMOUNT_TOLERANCE;
}

function compareDates(extracted: string | undefined, expected: string | undefined): boolean {
  if (extracted === undefined || expected === undefined) return false;
  return extracted === expected;
}

function evaluateFixture(fixture: OcrBenchmarkFixture, result: OcrExtractionResult): OcrBenchmarkRow {
  const gt = fixture.groundTruth;
  return {
    fixtureId: fixture.id,
    category: fixture.category,
    amountCorrect:
      gt.amount !== undefined ? compareAmounts(result.totalAmountCandidate?.value, gt.amount) : null,
    dateCorrect: gt.date !== undefined ? compareDates(result.dateCandidate?.value, gt.date) : null,
    currencyCorrect: gt.currency !== undefined ? result.currencyCandidate?.value === gt.currency : null,
    merchantCorrect: gt.merchant !== undefined ? result.merchantCandidate?.value === gt.merchant : null,
    paymentMethodCorrect:
      gt.paymentMethod !== undefined ? result.paymentMethodCandidate?.value === gt.paymentMethod : null,
    taxAmountCorrect:
      gt.taxAmount !== undefined ? compareAmounts(result.taxAmountCandidate?.value, gt.taxAmount) : null,
    last4Correct: gt.last4 !== undefined ? result.last4Candidate?.value === gt.last4 : null,
    amountConfidence: result.totalAmountCandidate?.confidence ?? null,
    dateConfidence: result.dateCandidate?.confidence ?? null,
    processingMs: result.processingMs,
    costEstimateMicroUsd: 0,
    error: null,
  };
}

function computeCorrectness(
  rows: readonly OcrBenchmarkRow[],
  field:
    | "amountCorrect"
    | "dateCorrect"
    | "currencyCorrect"
    | "merchantCorrect"
    | "paymentMethodCorrect"
    | "taxAmountCorrect"
    | "last4Correct"
): number {
  const evaluated = rows.filter((r) => r[field] !== null);
  if (evaluated.length === 0) return 1;
  const correct = evaluated.filter((r) => r[field] === true).length;
  return correct / evaluated.length;
}

const ALL_CATEGORIES: readonly OcrBenchmarkCategory[] = [
  "clean",
  "blur",
  "glare",
  "crop",
  "rotation",
  "multilingual",
];

function buildReport(rows: readonly OcrBenchmarkRow[]): OcrBenchmarkReport {
  const fixtureCount = rows.length;
  const amountCorrectness = computeCorrectness(rows, "amountCorrect");
  const dateCorrectness = computeCorrectness(rows, "dateCorrect");

  const maxProcessingMs = rows.reduce((m, r) => Math.max(m, r.processingMs), 0);
  const totalProcessingMs = rows.reduce((acc, r) => acc + r.processingMs, 0);
  const totalCostEstimateMicroUsd = rows.reduce((acc, r) => acc + r.costEstimateMicroUsd, 0);
  const averageProcessingMs = fixtureCount > 0 ? totalProcessingMs / fixtureCount : 0;

  const breakdown = {} as Record<OcrBenchmarkCategory, OcrCategoryBreakdown>;
  for (const cat of ALL_CATEGORIES) {
    const catRows = rows.filter((r) => r.category === cat);
    breakdown[cat] = {
      count: catRows.length,
      amountCorrectness: computeCorrectness(catRows, "amountCorrect"),
      dateCorrectness: computeCorrectness(catRows, "dateCorrect"),
    };
  }

  return {
    fixtureCount,
    amountCorrectness,
    dateCorrectness,
    currencyCorrectness: computeCorrectness(rows, "currencyCorrect"),
    merchantCorrectness: computeCorrectness(rows, "merchantCorrect"),
    paymentMethodCorrectness: computeCorrectness(rows, "paymentMethodCorrect"),
    taxAmountCorrectness: computeCorrectness(rows, "taxAmountCorrect"),
    last4Correctness: computeCorrectness(rows, "last4Correct"),
    amountThreshold: AMOUNT_CORRECTNESS_THRESHOLD,
    dateThreshold: DATE_CORRECTNESS_THRESHOLD,
    amountThresholdMet: amountCorrectness >= AMOUNT_CORRECTNESS_THRESHOLD,
    dateThresholdMet: dateCorrectness >= DATE_CORRECTNESS_THRESHOLD,
    averageProcessingMs,
    maxProcessingMs,
    totalCostEstimateMicroUsd,
    failureModeBreakdown: breakdown,
    rows,
    adapterDidPostFinancialTransaction: false,
  };
}

export async function runOcrBenchmark(
  adapter: OcrAdapter,
  fixtures: readonly OcrBenchmarkFixture[]
): Promise<OcrBenchmarkResult> {
  const rows: OcrBenchmarkRow[] = [];

  for (const fixture of fixtures) {
    try {
      const textBytes = new TextEncoder().encode(fixture.text);
      const result = await adapter.extract(textBytes.buffer, "text/plain");
      rows.push(evaluateFixture(fixture, result));
    } catch (err) {
      const gt = fixture.groundTruth;
      const fieldIfGt = <K extends keyof OcrBenchmarkGroundTruth>(k: K): boolean | null =>
        gt[k] !== undefined ? false : null;
      rows.push({
        fixtureId: fixture.id,
        category: fixture.category,
        amountCorrect: fieldIfGt("amount"),
        dateCorrect: fieldIfGt("date"),
        currencyCorrect: fieldIfGt("currency"),
        merchantCorrect: fieldIfGt("merchant"),
        paymentMethodCorrect: fieldIfGt("paymentMethod"),
        taxAmountCorrect: fieldIfGt("taxAmount"),
        last4Correct: fieldIfGt("last4"),
        amountConfidence: null,
        dateConfidence: null,
        processingMs: 0,
        costEstimateMicroUsd: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const report = buildReport(rows);
  return {
    report,
    thresholdMet: report.amountThresholdMet && report.dateThresholdMet,
  };
}
