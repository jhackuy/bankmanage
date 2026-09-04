/**
 * Provider-backed OCR adapter.
 *
 * Production-path adapter that splits the OCR pipeline into two seams:
 *   image bytes → [OcrProvider] → raw text → [parseOcrText] → candidates
 *
 * The provider is injectable so deterministic tests can substitute a mock
 * boundary while production wires a real OCR engine behind the same
 * interface (SPEC.md §12).
 *
 * This adapter accepts image document bytes (image/png, image/jpeg,
 * application/pdf) and normalizes the provider output into the same
 * `OcrExtractionResult` shape that `HeuristicOcrAdapter` produces, so
 * callers don't need to know which adapter backed the extraction.
 *
 * IMPORTANT: This adapter NEVER posts financial transactions.
 * It returns candidate fields only. Callers MUST enforce confidence
 * thresholds via `decideOcrReview` and require human confirmation
 * before any financial write (SPEC.md §12, AGENTS.md §3).
 */

import type { OcrAdapter, OcrExtractionResult } from "./interface.js";
import { parseOcrText } from "./parser.js";
import type { OcrProvider } from "./provider.js";

export class ProviderOcrAdapter implements OcrAdapter {
  constructor(private readonly provider: OcrProvider) {}

  async extract(imageData: ArrayBuffer, mimeType: string): Promise<OcrExtractionResult> {
    const start = Date.now();
    const { text } = await this.provider.extractText(imageData, mimeType);
    const parsed = parseOcrText(text);
    return {
      ...parsed,
      processingMs: Date.now() - start,
    };
  }
}
