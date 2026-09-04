/**
 * D1 implementation of the documents-storage repository.
 *
 * All SQL is parameterized. No raw D1 binding escapes this module — the
 * application service sees only the abstract `DocumentRepository` port.
 *
 * Race-safe exact-duplicate boundary:
 *   - `ensureBySha256` uses `INSERT OR IGNORE` against the UNIQUE index
 *     on `sha256_hex` (migration 0010), then SELECTs the row. The
 *     `created` flag is derived from the WRITE result, not a pre-read —
 *     a pre-read cannot give this answer because a concurrent caller may
 *     insert between read and write. Mirrors the reconciliation
 *     repository's `ensureReconciliation` pattern.
 *
 * Compensation contract:
 *   - If `INSERT OR IGNORE` raises for a non-unique-constraint reason,
 *     the repository re-throws. The application service catches that and
 *     deletes the just-written storage object. This module never touches
 *     the storage adapter; that responsibility lives in the service.
 */

import type { D1Database } from "../../adapters/d1/types.js";
import type { DocumentRepository, EnsureBySha256Result } from "./repository.js";
import type {
  DocumentKind,
  DocumentRecord,
  InsertDocumentInput,
  MemberContext,
  MemberRole,
} from "./types.js";

// ── Row type as stored in SQLite ────────────────────────────────────────────

interface DocumentRow {
  id: number;
  kind: string;
  owner_member_id: number;
  uploader_member_id: number;
  content_type: string;
  byte_size: number;
  sha256_hex: string;
  object_key: string;
  lifecycle_state: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    kind: row.kind as DocumentKind,
    ownerMemberId: row.owner_member_id,
    uploaderMemberId: row.uploader_member_id,
    contentType: row.content_type,
    byteSize: row.byte_size,
    sha256Hex: row.sha256_hex,
    objectKey: row.object_key,
    lifecycleState: "ACTIVE",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── D1 Repository ───────────────────────────────────────────────────────────

export class D1DocumentRepository implements DocumentRepository {
  constructor(private readonly db: D1Database) {}

  async ensureBySha256(input: InsertDocumentInput): Promise<EnsureBySha256Result> {
    // INSERT OR IGNORE then SELECT — the race-safe exact-duplicate
    // boundary (mirrors ensureReconciliation).
    const write = await this.db
      .prepare(
        `INSERT OR IGNORE INTO documents (
           kind, owner_member_id, uploader_member_id,
           content_type, byte_size, sha256_hex, object_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.kind,
        input.ownerMemberId,
        input.uploaderMemberId,
        input.contentType,
        input.byteSize,
        input.sha256Hex,
        input.objectKey
      )
      .run();
    // `created` is derived from the WRITE result, not a pre-read. The
    // UNIQUE index on sha256_hex makes changes=1 mean "this statement
    // inserted the row" and changes=0 mean "another writer already owns
    // it". A pre-read cannot give this answer because a concurrent caller
    // may insert between read and write.
    const created = (write.meta.changes ?? 0) > 0;
    const row = await this.db
      .prepare("SELECT * FROM documents WHERE sha256_hex = ?")
      .bind(input.sha256Hex)
      .first<DocumentRow>();
    if (row === null) {
      // Should be unreachable: UNIQUE constraint guarantees the row
      // exists after INSERT OR IGNORE, but we surface a typed failure
      // rather than throw to keep the service-layer error path uniform.
      throw new Error(`ensureBySha256: row missing after INSERT OR IGNORE for sha256=${input.sha256Hex}`);
    }
    return { record: rowToRecord(row), created };
  }

  async findById(id: number): Promise<DocumentRecord | null> {
    const row = await this.db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<DocumentRow>();
    return row === null ? null : rowToRecord(row);
  }

  async findBySha256(sha256Hex: string): Promise<DocumentRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM documents WHERE sha256_hex = ?")
      .bind(sha256Hex)
      .first<DocumentRow>();
    return row === null ? null : rowToRecord(row);
  }

  async listByOwner(ownerMemberId: number, limit?: number): Promise<DocumentRecord[]> {
    const sql =
      limit === undefined
        ? `SELECT * FROM documents
            WHERE owner_member_id = ?
            ORDER BY id DESC`
        : `SELECT * FROM documents
            WHERE owner_member_id = ?
            ORDER BY id DESC
            LIMIT ?`;
    const stmt = this.db
      .prepare(sql)
      .bind(...(limit === undefined ? [ownerMemberId] : [ownerMemberId, limit]));
    const result = await stmt.all<DocumentRow>();
    return result.results.map(rowToRecord);
  }

  async loadMemberContext(memberId: number): Promise<MemberContext | null> {
    const row = await this.db
      .prepare("SELECT id, role, active FROM household_members WHERE id = ?")
      .bind(memberId)
      .first<{ id: number; role: string; active: number }>();
    if (row === null) return null;
    return { memberId: row.id, role: row.role as MemberRole, active: row.active };
  }
}
