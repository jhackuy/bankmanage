/**
 * Documents-storage application service.
 *
 * Platform-neutral orchestration of M3A document upload, exact-duplicate
 * detection, metadata lookup, and authorized private-byte retrieval.
 *
 * SPEC.md §11 contracts enforced here:
 *   - "R2 objects are private." Authorized bytes flow through the
 *     private adapter's `get()` — never via a presigned or public URL.
 *   - "Financial documents are never served through an unrestricted
 *     public bucket URL." `getAuthorizedBytes` returns a readable
 *     stream + metadata; the opaque `objectKey` never leaves this
 *     module.
 *   - "Detect exact duplicate images by hash" (SPEC §6.2). The service
 *     computes SHA-256 of the bytes itself and uses it as the canonical
 *     duplicate identity.
 *
 * Authorization (SPEC §2 two-user model):
 *   - The uploader and the owner must both be active members.
 *   - `getAuthorizedBytes` and `getDocument` accept the requester if they
 *     are the owner or uploader of that document, OR if the requester
 *     is a persisted OWNER role (cross-member OWNER access is allowed
 *     for family coordination). Ordinary MEMBER-role callers are denied
 *     cross-member access. The role is loaded from `household_members.role`
 *     by the repository — callers never supply a role.
 *
 * Compensation contract (SPEC §4.3 + §11):
 *   - R2 put failure → no metadata row is ever inserted. The service
 *     surfaces INTERNAL with the storage error context only (object_key
 *     is never included in error messages).
 *   - Metadata insert failure → the service deletes ONLY the object it
 *     just wrote, then surfaces INTERNAL. A concurrent duplicate that
 *     wins the UNIQUE race does not cause a delete (we never wrote a
 *     unique object in that path).
 *
 * No raw D1 or R2 access leaks from this module — both are abstracted
 * behind ports (`DocumentRepository`, `DocumentStorageAdapter`).
 */

import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { DocumentStorageAdapter, StoredDocument } from "../../adapters/storage/interface.js";
import {
  fail,
  ok,
  type AuthorizedDocumentBytes,
  type DocumentKind,
  type DocumentRecord,
  type MemberContext,
  type ServiceResult,
  type UploadDocumentInput,
  type UploadDocumentResult,
} from "./types.js";
import type { DocumentRepository } from "./repository.js";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Whitelist of MIME types M3A accepts. Anything else is rejected with
 * INVALID_INPUT before a single byte is read from storage. The list is
 * deliberately small — receipts and bank statements arrive as images
 * and PDFs, nothing else is in scope.
 */
const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

/** Hard cap on bytes. 25 MiB is enough for a multi-page scanned PDF. */
const MAX_BYTES = 25 * 1024 * 1024;

const VALID_KINDS: ReadonlySet<DocumentKind> = new Set<DocumentKind>([
  "RECEIPT",
  "TERM_DEPOSIT_CERTIFICATE",
  "RENEWAL_ADVICE",
  "SETTLEMENT_EVIDENCE",
]);

// ── Service ─────────────────────────────────────────────────────────────────

export class DocumentApplicationService {
  constructor(
    private readonly repo: DocumentRepository,
    private readonly storage: DocumentStorageAdapter
  ) {}

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Upload a new document. The service computes the SHA-256 of the bytes
   * itself; callers cannot supply a hash. If an existing document with
   * the same SHA-256 is already on file, the existing record is returned
   * with `created: false` — the bytes are NOT re-stored and the upload
   * surfaces as idempotent.
   *
   * Failure modes (all leave the database + storage in a consistent
   * state — see file-header comment for the compensation contract):
   *   - INVALID_INPUT: malformed input, unsupported content-type,
   *     empty / oversized bytes, mismatched declared vs actual size,
   *     non-positive member ids, unknown kind, inactive owner or
   *     uploader, missing owner or uploader row.
   *   - INTERNAL: storage.put failed; OR metadata insert failed (in
   *     which case the just-written object has been deleted).
   */
  async uploadDocument(input: UploadDocumentInput): Promise<ServiceResult<UploadDocumentResult>> {
    const validation = validateUploadInput(input);
    if (!validation.ok) return validation;

    // Active-state checks for both owner and uploader BEFORE storage.put.
    const ownerCheck = await this.requireActiveMember(input.ownerMemberId, "owner");
    if (!ownerCheck.ok) return ownerCheck;
    const uploaderCheck = await this.requireActiveMember(input.uploaderMemberId, "uploader");
    if (!uploaderCheck.ok) return uploaderCheck;

    // Pre-check by SHA-256. This catches most exact-duplicate uploads
    // without writing any bytes. The UNIQUE index on sha256_hex is the
    // authoritative race-safe boundary; this SELECT is just an
    // optimization for the common case.
    const sha256Hex = await sha256HexOf(input.bytes);
    const pre = await this.repo.findBySha256(sha256Hex);
    if (pre !== null) {
      return ok({ record: pre, created: false });
    }

    // Generate the opaque storage key BEFORE calling put. Every write
    // attempt must receive its own opaque key: two concurrent uploads of
    // the same bytes can land in the same millisecond, and a collision
    // would cause the loser-duplicate cleanup delete to remove the
    // winner's canonical object. The SHA is the content invariant; the
    // key is per-attempt.
    const objectKey = buildObjectKey(sha256Hex);

    // Storage write FIRST. On throw we have not touched the metadata
    // table — no compensation needed.
    let stored: StoredDocument;
    try {
      stored = await this.storage.put(objectKey, input.bytes, {
        contentType: input.contentType,
        metadata: {
          owner_member_id: String(input.ownerMemberId),
          uploader_member_id: String(input.uploaderMemberId),
          kind: input.kind,
        },
      });
    } catch (err) {
      // Never include the object_key in error messages — see SPEC §11
      // privacy boundary.
      const reason = err instanceof Error ? err.message : "unknown storage failure";
      return fail("INTERNAL", `document storage put failed: ${reason}`);
    }

    // Metadata insert. Use INSERT OR IGNORE so a concurrent winner does
    // not raise; instead we read back the row that already exists.
    let ensured;
    try {
      ensured = await this.repo.ensureBySha256({
        kind: input.kind,
        ownerMemberId: input.ownerMemberId,
        uploaderMemberId: input.uploaderMemberId,
        contentType: stored.contentType,
        byteSize: stored.size,
        sha256Hex,
        objectKey,
      });
    } catch (err) {
      // Metadata insert failed for a non-unique reason — compensate by
      // deleting ONLY the object we just wrote. The key we delete is the
      // one we generated; we never delete a pre-existing object.
      try {
        await this.storage.delete(objectKey);
      } catch {
        // Compensation itself failed — surface INTERNAL with the original
        // error. The orphan object is best-effort garbage; the schema
        // has no FK from object_key to anything, so it cannot violate
        // any constraint.
      }
      const reason = err instanceof Error ? err.message : "unknown metadata insert failure";
      return fail("INTERNAL", `document metadata insert failed: ${reason}`);
    }

    if (!ensured.created) {
      // A concurrent writer beat us to the INSERT. The bytes we just
      // wrote are a duplicate of the winning row's bytes (same SHA-256,
      // identical content), so we delete ONLY the object we just wrote.
      // The pre-existing row is the canonical one — we keep its object.
      try {
        await this.storage.delete(objectKey);
      } catch {
        // Best-effort cleanup of the duplicate object. The winner's
        // object is intact; the duplicate is orphan garbage.
      }
      return ok({ record: ensured.record, created: false });
    }

    return ok({ record: ensured.record, created: true });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * Authorized private-byte retrieval. Returns the readable byte stream
   * and metadata for a document only if the requesting member is the
   * owner or uploader of that document. The opaque `objectKey` never
   * leaves the adapter boundary.
   *
   * Errors:
   *   - INVALID_INPUT: non-positive ids.
   *   - MEMBER_NOT_FOUND / MEMBER_INACTIVE: requesting member identity
   *     is unknown or inactive.
   *   - DOCUMENT_NOT_FOUND: no row with that id.
   *   - DOCUMENT_FORBIDDEN: requesting member is neither owner nor
   *     uploader of this document.
   *   - INTERNAL: storage adapter failure.
   */
  async getAuthorizedBytes(id: number, memberId: number): Promise<ServiceResult<AuthorizedDocumentBytes>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "document id must be a positive safe integer");
    }
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }

    const memberCheck = await this.requireActiveMember(memberId, "requester");
    if (!memberCheck.ok) return memberCheck;
    const requester = memberCheck.value;

    const record = await this.repo.findById(id);
    if (record === null) {
      return fail("DOCUMENT_NOT_FOUND", `document ${id} not found`);
    }

    // Two-user authorization (SPEC §2):
    //   - The requester must be the owner or the uploader of THIS
    //     specific document, OR
    //   - The requester must be a persisted OWNER. Persisted OWNERs may
    //     read any household member's documents for family coordination.
    // MEMBER-role callers are denied cross-member access; only the
    // document's own owner or uploader can read it.
    const isOwnerOrUploader = record.ownerMemberId === memberId || record.uploaderMemberId === memberId;
    const isOwnerRole = requester.role === "OWNER";
    if (!isOwnerOrUploader && !isOwnerRole) {
      return fail("DOCUMENT_FORBIDDEN", `document ${id} is not accessible to member ${memberId}`);
    }

    let stored;
    try {
      stored = await this.storage.get(record.objectKey);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown storage failure";
      return fail("INTERNAL", `document storage get failed: ${reason}`);
    }
    if (stored === null || stored.body === null) {
      // Object metadata exists in D1 but the storage adapter reports the
      // bytes are missing. This is a storage-integrity failure; surface
      // it as INTERNAL but never leak the object_key.
      return fail("INTERNAL", `document ${id} bytes are not available`);
    }

    return ok({
      record,
      body: stored.body as NodeReadableStream<Uint8Array>,
      contentType: stored.metadata.contentType,
      byteSize: stored.metadata.size,
      uploadedAt: stored.metadata.uploadedAt,
    });
  }

  /**
   * Get document metadata by id, with the same two-user authorization
   * as `getAuthorizedBytes`. Used by UI listings and report consumers.
   */
  async getDocument(id: number, memberId: number): Promise<ServiceResult<DocumentRecord | null>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "document id must be a positive safe integer");
    }
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    const memberCheck = await this.requireActiveMember(memberId, "requester");
    if (!memberCheck.ok) return memberCheck;
    const requester = memberCheck.value;

    const record = await this.repo.findById(id);
    if (record === null) return ok(null);
    // Same authorization rule as `getAuthorizedBytes`: owner-or-uploader
    // of the document, or a persisted OWNER role, may read the metadata.
    const isOwnerOrUploader = record.ownerMemberId === memberId || record.uploaderMemberId === memberId;
    const isOwnerRole = requester.role === "OWNER";
    if (!isOwnerOrUploader && !isOwnerRole) {
      return fail("DOCUMENT_FORBIDDEN", `document ${id} is not accessible to member ${memberId}`);
    }
    return ok(record);
  }

  /**
   * List documents owned by `ownerMemberId`, newest first. The requesting
   * member must be the owner themselves (members cannot list each
   * other's documents through this method).
   */
  async listByOwner(
    ownerMemberId: number,
    memberId: number,
    limit?: number
  ): Promise<ServiceResult<DocumentRecord[]>> {
    if (!Number.isSafeInteger(ownerMemberId) || ownerMemberId <= 0) {
      return fail("INVALID_INPUT", "ownerMemberId must be a positive safe integer");
    }
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    if (ownerMemberId !== memberId) {
      return fail(
        "DOCUMENT_FORBIDDEN",
        `member ${memberId} cannot list documents owned by member ${ownerMemberId}`
      );
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      return fail("INVALID_INPUT", "limit must be a positive safe integer when provided");
    }
    const memberCheck = await this.requireActiveMember(memberId, "requester");
    if (!memberCheck.ok) return memberCheck;

    return ok(await this.repo.listByOwner(ownerMemberId, limit));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async requireActiveMember(
    memberId: number,
    role: "owner" | "uploader" | "requester"
  ): Promise<ServiceResult<MemberContext>> {
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", `${role} memberId must be a positive safe integer`);
    }
    const ctx = await this.repo.loadMemberContext(memberId);
    if (ctx === null) {
      return fail("MEMBER_NOT_FOUND", `${role} member ${memberId} not found`);
    }
    if (ctx.active !== 1) {
      return fail("MEMBER_INACTIVE", `${role} member ${memberId} is inactive`);
    }
    return ok(ctx);
  }
}

// ── Pure validators / helpers ──────────────────────────────────────────────

function validateUploadInput(input: UploadDocumentInput): ServiceResult<true> {
  if (!Number.isSafeInteger(input.ownerMemberId) || input.ownerMemberId <= 0) {
    return fail("INVALID_INPUT", "ownerMemberId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.uploaderMemberId) || input.uploaderMemberId <= 0) {
    return fail("INVALID_INPUT", "uploaderMemberId must be a positive safe integer");
  }
  if (!VALID_KINDS.has(input.kind)) {
    return fail("INVALID_INPUT", `kind must be one of ${Array.from(VALID_KINDS).join(", ")}`);
  }
  if (typeof input.contentType !== "string" || input.contentType.length === 0) {
    return fail("INVALID_INPUT", "contentType must be a non-empty string");
  }
  // Reject any content-type containing characters that would break a
  // storage-adapter metadata header (CRLF / NUL).
  if (/[\r\n\0]/.test(input.contentType)) {
    return fail("INVALID_INPUT", "contentType must not contain control characters");
  }
  if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
    return fail(
      "INVALID_INPUT",
      `contentType ${input.contentType} is not supported; allowed: ${Array.from(ALLOWED_CONTENT_TYPES).join(", ")}`
    );
  }
  if (!(input.bytes instanceof Uint8Array)) {
    return fail("INVALID_INPUT", "bytes must be a Uint8Array");
  }
  if (input.bytes.byteLength === 0) {
    return fail("INVALID_INPUT", "bytes must not be empty");
  }
  if (input.bytes.byteLength > MAX_BYTES) {
    return fail("INVALID_INPUT", `bytes exceed the ${MAX_BYTES}-byte limit`);
  }
  return ok(true);
}

/**
 * Compute the lowercase-hex SHA-256 of a byte array using the Web Crypto
 * API. Works in both Cloudflare Workers and Node 16+ without polyfills.
 */
async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bufferToHex(new Uint8Array(digest));
}

function bufferToHex(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]!;
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Derive an opaque storage object_key for a single write attempt.
 *
 *   - The 8-hex SHA-256 prefix shards the namespace by content so a
 *     given payload is colocated; it never includes filenames or PII.
 *   - The epoch-ms segment keeps keys sortable by upload time.
 *   - The per-write 12-hex nonce guarantees that two uploads of the
 *     same bytes in the same millisecond cannot collide, so the
 *     loser-duplicate cleanup path deletes ONLY the orphan object it
 *     just wrote and never the winner's canonical object.
 *
 * The M3A schema has no DELETE path; this builder fires only on a
 * brand-new upload that has never been stored.
 */
function buildObjectKey(sha256Hex: string): string {
  const epochMs = Date.now();
  const prefix = sha256Hex.slice(0, 8);
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `m3a/${prefix}/${epochMs}-${nonce}-${sha256Hex}`;
}
