/**
 * Documents-storage application-service types.
 *
 * Platform-neutral types describing the document entity as the application
 * service sees it. The repository layer is responsible for mapping between
 * these types and SQLite rows.
 *
 * SPEC.md §11 contract enforced by this slice:
 *   - "R2 objects are private." The application never persists an
 *     unrestricted public bucket URL — only the opaque R2 object_key.
 *   - "Financial documents are never served through an unrestricted
 *     public bucket URL." The service exposes authorized bytes only
 *     through `getAuthorizedBytes`, never a presigned URL.
 *   - "Detect exact duplicate images by hash" (SPEC §6.2) — the
 *     `sha256Hex` of the bytes is the canonical duplicate identity.
 *
 * Role separation:
 *   - The `kind` describes what the document is.
 *   - `ownerMemberId` is the household member the document belongs to;
 *     `uploaderMemberId` is the member who uploaded it. They may
 *     differ (e.g. OWNER uploads a RENEWAL_ADVICE for a MEMBER's TD).
 *   - The opaque `objectKey` is the storage adapter's identifier; it is
 *     never returned in error messages or surfaced to UI layers.
 */

import type { ReadableStream } from "node:stream/web";

// ── Persisted document entity ────────────────────────────────────────────────

/**
 * The kinds of document this slice persists. Mirrors the CHECK
 * constraint declared in migration 0009.
 */
export type DocumentKind = "RECEIPT" | "TERM_DEPOSIT_CERTIFICATE" | "RENEWAL_ADVICE" | "SETTLEMENT_EVIDENCE";

export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  "RECEIPT",
  "TERM_DEPOSIT_CERTIFICATE",
  "RENEWAL_ADVICE",
  "SETTLEMENT_EVIDENCE",
] as const;

export interface DocumentRecord {
  readonly id: number;
  readonly kind: DocumentKind;
  readonly ownerMemberId: number;
  readonly uploaderMemberId: number;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
  /** Opaque storage key. Never log, never serialize to UI, never include in errors. */
  readonly objectKey: string;
  readonly lifecycleState: "ACTIVE";
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Service input / output types ─────────────────────────────────────────────

/**
 * Caller-facing upload input. The service computes `sha256Hex` from
 * `bytes` itself — callers cannot supply a hash. `contentType` and
 * `byteSize` are cross-checked against the actual bytes; mismatches
 * are rejected with INVALID_INPUT.
 */
export interface UploadDocumentInput {
  readonly kind: DocumentKind;
  readonly ownerMemberId: number;
  readonly uploaderMemberId: number;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface UploadDocumentResult {
  readonly record: DocumentRecord;
  /** True if a brand-new document row was inserted; false if an existing
   *  record with the same sha256 was returned (exact duplicate). */
  readonly created: boolean;
}

/**
 * Authorized bytes returned by `getAuthorizedBytes`. The body is a
 * readable stream of the private R2 object; the metadata is the
 * adapter-side descriptor (size, content-type, upload timestamp).
 *
 * The stream and metadata both stay inside the service boundary; UI
 * layers consume the record's metadata and the body without ever
 * receiving the opaque `objectKey`.
 */
export interface AuthorizedDocumentBytes {
  readonly record: DocumentRecord;
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
  readonly byteSize: number;
  readonly uploadedAt: string;
}

// ── Internal repository input ────────────────────────────────────────────────

/**
 * Internal repository input used by the service after it has computed
 * the SHA-256 and generated the opaque object_key. Never exposed to
 * callers; the repository port owns the column shape.
 */
export interface InsertDocumentInput {
  readonly kind: DocumentKind;
  readonly ownerMemberId: number;
  readonly uploaderMemberId: number;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly objectKey: string;
}

// ── Result types (mirrors accounts/reconciliation) ───────────────────────────

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ServiceError };

export interface ServiceError {
  readonly code: ServiceErrorCode;
  readonly message: string;
}

export type ServiceErrorCode =
  | "INVALID_INPUT"
  | "MEMBER_NOT_FOUND"
  | "MEMBER_INACTIVE"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_FORBIDDEN"
  | "INTERNAL";

/**
 * The two pilot roles persisted on `household_members.role` (CHECK
 * constraint from migration 0001). Mirrors the literal union declared in
 * the schema. The documents-storage service uses the role to authorize
 * cross-member document access (OWNER may read another member's
 * documents; MEMBER may not).
 */
export type MemberRole = "OWNER" | "MEMBER";

/**
 * Minimal member context loaded by the repository for the application
 * service's active-state and role checks. Mirrors the shape used by the
 * accounts and term-deposit repositories so the same `requireActiveMember`
 * pattern is reusable, plus the persisted role loaded directly from the
 * `household_members` row (never from a caller-supplied input).
 */
export interface MemberContext {
  readonly memberId: number;
  readonly active: number;
  readonly role: MemberRole;
}

export function serviceError(code: ServiceErrorCode, message: string): ServiceError {
  return { code, message };
}

export function ok<T>(value: T): ServiceResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ServiceErrorCode, message: string): ServiceResult<T> {
  return { ok: false, error: { code, message } };
}
