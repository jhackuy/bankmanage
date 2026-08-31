/**
 * OCR / document-extraction adapter interface.
 *
 * M0 defines the boundary only. No OCR provider is implemented until M3.
 * See SPEC.md §12 for acceptance gate requirements.
 *
 * IMPORTANT: OCR output is always a candidate, never a financial source of truth.
 * Any extracted amount/date must pass human confirmation before posting.
 */

export interface OcrCandidateField {
  readonly value: string;
  /** Confidence 0.0–1.0. Low-confidence critical fields must not auto-post. */
  readonly confidence: number;
}

export interface OcrExtractionResult {
  /** Suggested total amount (string, not float). Parse with integer minor-unit logic. */
  readonly totalAmountCandidate?: OcrCandidateField;
  readonly dateCandidate?: OcrCandidateField;
  readonly merchantCandidate?: OcrCandidateField;
  readonly currencyCandidate?: OcrCandidateField;
  readonly paymentMethodCandidate?: OcrCandidateField;
  /** Tax amount if visible on receipt. */
  readonly taxAmountCandidate?: OcrCandidateField;
  /** Last 4 digits of card/receipt number if visible. */
  readonly last4Candidate?: OcrCandidateField;
  /** Provider-specific raw text for audit/debug (never auto-posted). */
  readonly rawText?: string;
  /** Latency in milliseconds. */
  readonly processingMs: number;
}

export interface OcrAdapter {
  /**
   * Extract candidate fields from a document image.
   * Returns candidates for human review, never auto-posts.
   */
  extract(imageData: ArrayBuffer, mimeType: string): Promise<OcrExtractionResult>;
}
