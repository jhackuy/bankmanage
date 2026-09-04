/**
 * Documents-storage repository port.
 *
 * Abstract interface the application service depends on. The D1 adapter
 * in `d1-repository.ts` is the production implementation; tests can
 * substitute other implementations behind the same port.
 *
 * All SQL is parameterized in the adapter — the application service sees
 * only the abstract port and never composes SQL.
 *
 * Race-safe exact-duplicate boundary:
 *   - Migration 0010 added a UNIQUE index on `sha256_hex`. The repository
 *     uses `INSERT OR IGNORE` against that index so two concurrent
 *     uploads with identical bytes cannot both succeed: one writer wins
 *     (`changes=1`) and the loser observes `changes=0` and reads back the
 *     existing row.
 */

import type { DocumentRecord, InsertDocumentInput, MemberContext } from "./types.js";

/**
 * Result of `ensureBySha256`. Mirrors the reconciliation repository's
 * race-safe idempotency result: `created=true` means THIS call inserted
 * the row, `created=false` means another writer already owns it.
 */
export interface EnsureBySha256Result {
  readonly record: DocumentRecord;
  readonly created: boolean;
}

export interface DocumentRepository {
  /**
   * Insert a new document metadata row keyed by sha256_hex. If a row with
   * the same sha256 already exists, the existing record is returned with
   * `created=false`. The UNIQUE index on sha256_hex (migration 0010) is
   * the authoritative boundary.
   */
  ensureBySha256(input: InsertDocumentInput): Promise<EnsureBySha256Result>;

  /** Look up a document by id. Returns null if not found. */
  findById(id: number): Promise<DocumentRecord | null>;

  /** Look up a document by sha256_hex. Returns null if not found. */
  findBySha256(sha256Hex: string): Promise<DocumentRecord | null>;

  /**
   * List documents owned by `ownerMemberId`, newest first.
   * `limit` is optional; when omitted, returns every row.
   */
  listByOwner(ownerMemberId: number, limit?: number): Promise<DocumentRecord[]>;

  /**
   * Minimal member context load used for active-state checks. Mirrors
   * `AccountRepository.loadMemberContext` so the service can reuse the
   * same `requireActiveMember` pattern.
   */
  loadMemberContext(memberId: number): Promise<MemberContext | null>;
}

/**
 * Shape of `MemberContext` re-exported for callers. Lives here so the
 * application service can take `DocumentRepository["loadMemberContext"]`
 * returns without a separate import.
 */
export type { MemberContext };
