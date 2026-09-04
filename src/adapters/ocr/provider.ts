/**
 * OCR provider boundary.
 *
 * Per SPEC.md §12: the OCR/extraction provider must be behind an adapter
 * interface. This module defines the provider contract — raw image bytes
 * in, extracted text out — and a deterministic mock implementation used
 * by the benchmark harness and unit tests.
 *
 * Production wiring (Cloudflare Workers AI, PaddleOCR, or a documented
 * fallback) implements the same `OcrProvider` interface. The provider is
 * the seam between image ingestion and the deterministic text parser;
 * swapping providers must not change downstream parsing.
 *
 * IMPORTANT: Providers return text only. They MUST NOT post financial
 * transactions, finalize deposits, or mutate any persistent state. The
 * review gate in `confidence.ts` enforces the no-auto-post invariant.
 */

export interface OcrProviderResult {
  readonly text: string;
}

export interface OcrProvider {
  extractText(imageBytes: ArrayBuffer, mimeType: string): Promise<OcrProviderResult>;
}

export class MockOcrProvider implements OcrProvider {
  async extractText(imageBytes: ArrayBuffer, _mimeType: string): Promise<OcrProviderResult> {
    return { text: new TextDecoder("utf-8").decode(new Uint8Array(imageBytes)) };
  }
}
