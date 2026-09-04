/**
 * OCR review gate.
 *
 * This module enforces SPEC.md §12 + AGENTS.md §3: low-confidence or
 * missing critical OCR fields MUST be intercepted for human review and
 * MUST NOT cause an automatic financial posting.
 *
 * The gate is the structural enforcement that proves the adapter can
 * never auto-post a financial transaction.
 */

import type { OcrCandidateField, OcrExtractionResult } from "./interface.js";
import { DEFAULT_CRITICAL_CONFIDENCE_THRESHOLD } from "./parser.js";

export interface OcrReviewDecision {
  readonly requiresReview: boolean;
  readonly reasons: readonly string[];
  readonly amountConfidence: number | null;
  readonly dateConfidence: number | null;
}

export function decideOcrReview(
  result: OcrExtractionResult,
  threshold: number = DEFAULT_CRITICAL_CONFIDENCE_THRESHOLD
): OcrReviewDecision {
  const reasons: string[] = [];

  const amountConfidence = result.totalAmountCandidate?.confidence ?? null;
  if (result.totalAmountCandidate === undefined) {
    reasons.push("missing total amount candidate");
  } else if (amountConfidence !== null && amountConfidence < threshold) {
    reasons.push(`total amount confidence ${amountConfidence} below threshold ${threshold}`);
  }

  const dateConfidence = result.dateCandidate?.confidence ?? null;
  if (result.dateCandidate === undefined) {
    reasons.push("missing date candidate");
  } else if (dateConfidence !== null && dateConfidence < threshold) {
    reasons.push(`date confidence ${dateConfidence} below threshold ${threshold}`);
  }

  return {
    requiresReview: reasons.length > 0,
    reasons,
    amountConfidence,
    dateConfidence,
  };
}

export function isCriticalFieldLowConfidence(
  field: OcrCandidateField | undefined,
  threshold: number = DEFAULT_CRITICAL_CONFIDENCE_THRESHOLD
): boolean {
  if (field === undefined) return true;
  return field.confidence < threshold;
}
