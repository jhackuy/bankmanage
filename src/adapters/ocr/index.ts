export type { OcrAdapter, OcrCandidateField, OcrExtractionResult } from "./interface.js";
export { parseOcrText, DEFAULT_CRITICAL_CONFIDENCE_THRESHOLD } from "./parser.js";
export type { OcrParseOptions } from "./parser.js";
export { HeuristicOcrAdapter } from "./heuristic-adapter.js";
export { decideOcrReview, isCriticalFieldLowConfidence } from "./confidence.js";
export type { OcrReviewDecision } from "./confidence.js";
export { runOcrBenchmark, AMOUNT_CORRECTNESS_THRESHOLD, DATE_CORRECTNESS_THRESHOLD } from "./benchmark.js";
export type {
  OcrBenchmarkFixture,
  OcrBenchmarkGroundTruth,
  OcrBenchmarkCategory,
  OcrBenchmarkRow,
  OcrBenchmarkReport,
  OcrBenchmarkResult,
  OcrCategoryBreakdown,
} from "./benchmark.js";
export { OCR_BENCHMARK_FIXTURES, OCR_BENCHMARK_MIN_FIXTURES } from "./fixtures.js";
