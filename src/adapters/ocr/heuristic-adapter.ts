/**
 * Deterministic OCR adapter for the M3 benchmark gate.
 *
 * Production-path adapter behind `OcrAdapter`. In a real deployment the
 * `extract` method would dispatch image bytes to a vision/OCR provider
 * (Cloudflare Workers AI, PaddleOCR in an approved runtime, or another
 * fallback) and pass the returned raw text through `parseOcrText`.
 *
 * For the M3 benchmark harness (Issue #43) the adapter accepts
 * UTF-8 text-encoded synthetic documents. Real image processing is not
 * yet wired; the adapter's `extract` method is the production integration
 * seam — only the document bytes source is synthetic for testing.
 *
 * IMPORTANT: This adapter NEVER posts financial transactions.
 * It returns candidate fields only. Callers MUST enforce confidence
 * thresholds and require human confirmation before any financial write.
 *
 * See SPEC.md §12 and AGENTS.md §3.
 */

import type { OcrAdapter, OcrExtractionResult } from "./interface.js";
import { parseOcrText } from "./parser.js";

export class HeuristicOcrAdapter implements OcrAdapter {
  /**
   * Extract candidate fields from a document image.
   *
   * For the M3 benchmark, `imageData` is UTF-8 text bytes of a synthetic
   * document (the production adapter would replace this with a vision API
   * call returning raw text). The adapter decodes the bytes and runs the
   * deterministic `parseOcrText` extractor.
   *
   * @param imageData UTF-8 text bytes of the synthetic document.
   * @param mimeType  Must start with `text/` for this benchmark build.
   * @returns Candidate fields only. Never a posted transaction.
   */
  async extract(imageData: ArrayBuffer, mimeType: string): Promise<OcrExtractionResult> {
    const start = Date.now();

    if (!mimeType.startsWith("text/")) {
      throw new Error(
        `HeuristicOcrAdapter: unsupported mime type "${mimeType}". ` +
          `Only text/* is supported in the M3 benchmark build. ` +
          `The production provider integration is the open follow-up.`
      );
    }

    const rawText = new TextDecoder("utf-8").decode(new Uint8Array(imageData));
    const parsed = parseOcrText(rawText);

    return {
      ...parsed,
      processingMs: Date.now() - start,
    };
  }
}
