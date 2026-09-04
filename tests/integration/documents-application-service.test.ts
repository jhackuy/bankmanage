/**
 * M3A documents application-service tests.
 *
 * Exercises the full service stack through the FakeD1Database so the
 * same code path that runs in production is under test (no mocks of the
 * service or repository). The fake storage adapter mirrors the real R2
 * adapter boundary so the service's authorization, compensation, and
 * duplicate-detection behaviour is the production behaviour.
 *
 * Covers the acceptance cases Issue #34 ships:
 *   - Happy path: validated upload → metadata row + stored bytes;
 *     metadata read; authorized private-byte read.
 *   - Exact duplicate (sequential): pre-check sees the row, second
 *     upload returns created=false without a second storage put.
 *   - Exact duplicate (race-safe): two concurrent uploads of identical
 *     bytes → exactly one row, one returns created=true, one created=false.
 *   - Authorization: cross-member read is DOCUMENT_FORBIDDEN; the
 *     requester must be the owner or uploader of the specific document.
 *   - Authorization: listByOwner rejects when the requester is not the
 *     owner.
 *   - Active-member checks: MEMBER_NOT_FOUND / MEMBER_INACTIVE for
 *     owner and uploader on write; MEMBER_NOT_FOUND / MEMBER_INACTIVE
 *     for requester on read.
 *   - Input validation: unsupported content-type, empty bytes, oversized
 *     bytes, invalid kind, non-positive member ids, non-positive
 *     document id.
 *   - Failure injection: storage.put throws → INTERNAL, no metadata row.
 *   - Compensation: metadata insert throws → storage.delete called only
 *     for the just-written object; no object_key leaked in errors.
 *   - Privacy: error messages never include the opaque object_key.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import { FakeDocumentStorageAdapter } from "../../src/adapters/storage/index.js";
import { D1DocumentRepository } from "../../src/services/documents-storage/d1-repository.js";
import { DocumentApplicationService } from "../../src/services/documents-storage/service.js";
import type {
  DocumentRepository,
  EnsureBySha256Result,
} from "../../src/services/documents-storage/repository.js";
import type { InsertDocumentInput } from "../../src/services/documents-storage/types.js";
import type { DocumentStorageAdapter, StoredDocument } from "../../src/adapters/storage/interface.js";

interface Seed {
  ownerId: number;
  uploaderId: number;
  otherId: number;
  /** MEMBER-role active member (neither owner nor uploader of any doc). */
  memberId: number;
  inactiveId: number;
}

/** A small wrapper that lets tests force storage failures. */
class FailingStorageAdapter implements DocumentStorageAdapter {
  private readonly inner: FakeDocumentStorageAdapter;
  failPut: boolean;
  failDelete: boolean;

  constructor(inner: FakeDocumentStorageAdapter) {
    this.inner = inner;
    this.failPut = false;
    this.failDelete = false;
  }

  async put(
    key: string,
    data: ReadableStream | ArrayBuffer | Uint8Array,
    options: { contentType: string; metadata?: Record<string, string> }
  ): Promise<StoredDocument> {
    if (this.failPut) throw new Error("forced storage put failure");
    return this.inner.put(key, data, options);
  }

  async get(key: string): Promise<{ body: ReadableStream | null; metadata: StoredDocument } | null> {
    return this.inner.get(key);
  }

  async delete(key: string): Promise<void> {
    if (this.failDelete) throw new Error("forced storage delete failure");
    return this.inner.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }

  // Test helpers proxied to the inner fake.
  get size(): number {
    return this.inner.size;
  }
}

let db: FakeD1Database;
let repo: D1DocumentRepository;
let storage: FakeDocumentStorageAdapter;
let service: DocumentApplicationService;

beforeEach(async () => {
  db = new FakeD1Database();
  repo = new D1DocumentRepository(db);
  storage = new FakeDocumentStorageAdapter();
  service = new DocumentApplicationService(repo, storage);

  // Two active household members (OWNER + MEMBER) plus one OWNER, one
  // ordinary MEMBER for cross-member access tests, and one inactive.
  const owner = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Docs Test Owner")
    .run();
  const uploader = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("MEMBER", "Docs Test Uploader")
    .run();
  const other = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Docs Test Other Owner")
    .run();
  const member = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("MEMBER", "Docs Test Other Member")
    .run();
  const inactive = await db
    .prepare("INSERT INTO household_members (role, display_name, active) VALUES (?, ?, 0)")
    .bind("MEMBER", "Docs Test Inactive")
    .run();

  const seed: Seed = {
    ownerId: Number(owner.meta.last_row_id),
    uploaderId: Number(uploader.meta.last_row_id),
    otherId: Number(other.meta.last_row_id),
    memberId: Number(member.meta.last_row_id),
    inactiveId: Number(inactive.meta.last_row_id),
  };
  seedOwner = seed;
});

afterEach(() => {
  db.close();
});

// Per-suite seed holder — populated in beforeEach.
let seedOwner: Seed;

function seed(): Seed {
  return seedOwner;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function countDocs(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM documents").first<{ c: number }>();
  return row?.c ?? 0;
}

function makeBytes(seed: string): Uint8Array {
  // Deterministic synthetic payload; sha256 varies with the seed.
  const data = `m3a-test-${seed}-${Math.random().toString(36).slice(2, 10)}`;
  return new TextEncoder().encode(data);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let out = "";
  const arr = new Uint8Array(digest);
  for (let i = 0; i < arr.length; i++) {
    out += arr[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

// ── Happy paths ─────────────────────────────────────────────────────────────

describe("uploadDocument — happy path", () => {
  it("uploads a PDF, persists metadata, and returns created=true", async () => {
    const s = seed();
    const bytes = makeBytes("pdf-1");

    const result = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    expect(result.value.record.kind).toBe("RECEIPT");
    expect(result.value.record.ownerMemberId).toBe(s.ownerId);
    expect(result.value.record.uploaderMemberId).toBe(s.uploaderId);
    expect(result.value.record.contentType).toBe("application/pdf");
    expect(result.value.record.byteSize).toBe(bytes.byteLength);
    expect(result.value.record.sha256Hex).toHaveLength(64);
    expect(result.value.record.lifecycleState).toBe("ACTIVE");
    expect(result.value.record.objectKey).toMatch(/^m3a\//);
    expect(await countDocs()).toBe(1);
    expect(storage.size).toBe(1);
  });

  it("accepts every allowed MIME type", async () => {
    const s = seed();
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"];
    for (const ct of allowed) {
      const r = await service.uploadDocument({
        kind: "RECEIPT",
        ownerMemberId: s.ownerId,
        uploaderMemberId: s.uploaderId,
        contentType: ct,
        bytes: makeBytes(`ct-${ct}`),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.record.contentType).toBe(ct);
    }
  });

  it("allows owner==uploader (self-upload)", async () => {
    const s = seed();
    const r = await service.uploadDocument({
      kind: "TERM_DEPOSIT_CERTIFICATE",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.ownerId,
      contentType: "image/jpeg",
      bytes: makeBytes("self"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.ownerMemberId).toBe(s.ownerId);
    expect(r.value.record.uploaderMemberId).toBe(s.ownerId);
  });
});

// ── Exact duplicate detection ───────────────────────────────────────────────

describe("uploadDocument — exact duplicate (sequential)", () => {
  it("a second upload with identical bytes returns created=false and does not store twice", async () => {
    const s = seed();
    const bytes = makeBytes("dup-seq");
    const expectedSha = await sha256Hex(bytes);

    const first = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstId = first.value.record.id;
    const firstSha = first.value.record.sha256Hex;
    expect(firstSha).toBe(expectedSha);
    expect(storage.size).toBe(1);

    const second = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.created).toBe(false);
    expect(second.value.record.id).toBe(firstId);
    expect(second.value.record.sha256Hex).toBe(firstSha);

    expect(await countDocs()).toBe(1);
    expect(storage.size).toBe(1);
  });
});

describe("uploadDocument — exact duplicate (concurrent)", () => {
  it("two concurrent uploads with identical bytes produce exactly one row; one wins", async () => {
    const s = seed();
    const bytes = makeBytes("dup-conc");

    const [r1, r2] = await Promise.all([
      service.uploadDocument({
        kind: "RECEIPT",
        ownerMemberId: s.ownerId,
        uploaderMemberId: s.uploaderId,
        contentType: "image/png",
        bytes,
      }),
      service.uploadDocument({
        kind: "RECEIPT",
        ownerMemberId: s.ownerId,
        uploaderMemberId: s.uploaderId,
        contentType: "image/png",
        bytes,
      }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    // Exactly one of them reports created=true and both share the same row id.
    const createdFlags = [r1.value.created, r2.value.created].sort();
    expect(createdFlags).toEqual([false, true]);
    expect(r1.value.record.id).toBe(r2.value.record.id);
    expect(r1.value.record.sha256Hex).toBe(r2.value.record.sha256Hex);

    // Exactly one metadata row.
    expect(await countDocs()).toBe(1);
  });
});

/**
 * Deterministic same-timestamp duplicate test.
 *
 * Forces both concurrent uploads to derive the same epoch-ms inside
 * buildObjectKey, then releases the two storage writes through a
 * barrier so they enter the fake storage in the same window. Proves
 * the per-attempt nonce in buildObjectKey prevents the loser-cleanup
 * path from deleting the winner's canonical object.
 */
class BarrierStorageAdapter implements DocumentStorageAdapter {
  private readonly inner: FakeDocumentStorageAdapter;
  readonly putKeys: string[] = [];
  private pending: Array<() => void> = [];

  constructor(inner: FakeDocumentStorageAdapter) {
    this.inner = inner;
  }

  async put(
    key: string,
    data: ReadableStream | ArrayBuffer | Uint8Array,
    options: { contentType: string; metadata?: Record<string, string> }
  ): Promise<StoredDocument> {
    this.putKeys.push(key);
    // Both callers arrive, then `release()` resolves them simultaneously
    // so the two inner.put() calls fire in the same Date.now() window.
    await new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
    return this.inner.put(key, data, options);
  }

  async get(key: string): Promise<{ body: ReadableStream | null; metadata: StoredDocument } | null> {
    return this.inner.get(key);
  }

  async delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }

  get size(): number {
    return this.inner.size;
  }

  release(): void {
    const p = this.pending;
    this.pending = [];
    for (const r of p) r();
  }
}

describe("uploadDocument — exact duplicate (synchronized same-timestamp)", () => {
  it("forces identical epoch-ms across two concurrent uploads, asserts distinct keys, one retained object, and authorized byte retrieval after loser cleanup", async () => {
    const s = seed();
    const bytes = makeBytes("dup-barr");

    const realNow = Date.now;
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const barrier = new BarrierStorageAdapter(storage);
    const barrierService = new DocumentApplicationService(repo, barrier);

    try {
      const uploadOne = barrierService.uploadDocument({
        kind: "RECEIPT",
        ownerMemberId: s.ownerId,
        uploaderMemberId: s.uploaderId,
        contentType: "image/png",
        bytes,
      });
      const uploadTwo = barrierService.uploadDocument({
        kind: "RECEIPT",
        ownerMemberId: s.ownerId,
        uploaderMemberId: s.uploaderId,
        contentType: "image/png",
        bytes,
      });

      // Spin until both put() calls have entered the barrier; then release.
      while (barrier.putKeys.length < 2) {
        await new Promise((r) => setTimeout(r, 0));
      }
      barrier.release();

      const [r1, r2] = await Promise.all([uploadOne, uploadTwo]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;

      // Both attempts wrote under distinct opaque keys — the nonce in
      // buildObjectKey prevents same-timestamp same-SHA collisions.
      expect(barrier.putKeys).toHaveLength(2);
      expect(new Set(barrier.putKeys).size).toBe(2);
      // Both keys must keep the m3a/{prefix}/... privacy-safe structure.
      for (const k of barrier.putKeys) {
        expect(k).toMatch(/^m3a\/[0-9a-f]{8}\/[0-9]+-[0-9a-f]{12}-[0-9a-f]{64}$/);
      }

      // Exactly one row, exactly one reports created=true, both share id.
      const createdFlags = [r1.value.created, r2.value.created].sort();
      expect(createdFlags).toEqual([false, true]);
      expect(r1.value.record.id).toBe(r2.value.record.id);
      expect(r1.value.record.sha256Hex).toBe(r2.value.record.sha256Hex);
      expect(await countDocs()).toBe(1);

      // Exactly one retained storage object — loser-cleanup deleted its
      // own orphan and left the winner's bytes untouched.
      expect(storage.size).toBe(1);

      // Authorized private-byte retrieval after the loser-cleanup path
      // must still return the original payload through the surviving
      // object — this would fail if the loser had deleted the winner.
      const record = r1.value.created ? r1.value.record : r2.value.record;
      const got = await barrierService.getAuthorizedBytes(record.id, s.ownerId);
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.value.byteSize).toBe(bytes.byteLength);
      expect(got.value.contentType).toBe("image/png");

      // Drain the stream and verify byte-equality with the original input.
      const reader = got.value.body.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      expect(out).toEqual(bytes);
    } finally {
      Date.now = realNow;
    }
  });
});

// ── Authorization ───────────────────────────────────────────────────────────

describe("authorization", () => {
  it("uploadDocument rejects an unknown owner with MEMBER_NOT_FOUND", async () => {
    const s = seed();
    const r = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: 9_999_999,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: makeBytes("missing-owner"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_NOT_FOUND");
    expect(await countDocs()).toBe(0);
    expect(storage.size).toBe(0);
  });

  it("uploadDocument rejects an inactive owner with MEMBER_INACTIVE", async () => {
    const s = seed();
    const r = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.inactiveId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: makeBytes("inactive-owner"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_INACTIVE");
    expect(await countDocs()).toBe(0);
  });

  it("uploadDocument rejects an inactive uploader with MEMBER_INACTIVE", async () => {
    const s = seed();
    const r = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.inactiveId,
      contentType: "application/pdf",
      bytes: makeBytes("inactive-uploader"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_INACTIVE");
    expect(await countDocs()).toBe(0);
  });

  it("getAuthorizedBytes rejects an ordinary MEMBER who is neither owner nor uploader", async () => {
    const s = seed();
    const uploaded = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: makeBytes("auth-bytes"),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const r = await service.getAuthorizedBytes(uploaded.value.record.id, s.memberId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("DOCUMENT_FORBIDDEN");
  });

  it("getAuthorizedBytes allows a persisted OWNER to read another member's document bytes", async () => {
    const s = seed();
    const uploaded = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: makeBytes("owner-cross-bytes"),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    // Sanity: the cross-member OWNER is neither the owner nor the uploader
    // of this specific document.
    expect(s.otherId).not.toBe(uploaded.value.record.ownerMemberId);
    expect(s.otherId).not.toBe(uploaded.value.record.uploaderMemberId);

    const r = await service.getAuthorizedBytes(uploaded.value.record.id, s.otherId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.id).toBe(uploaded.value.record.id);
    expect(r.value.byteSize).toBeGreaterThan(0);
    expect(r.value.contentType).toBe("application/pdf");
  });

  it("getAuthorizedBytes allows the owner", async () => {
    const s = seed();
    const uploaded = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: makeBytes("owner-read"),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const r = await service.getAuthorizedBytes(uploaded.value.record.id, s.ownerId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.record.id).toBe(uploaded.value.record.id);
    expect(r.value.byteSize).toBeGreaterThan(0);
    expect(r.value.contentType).toBe("application/pdf");
  });

  it("getAuthorizedBytes allows the uploader", async () => {
    const s = seed();
    const uploaded = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: makeBytes("uploader-read"),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const r = await service.getAuthorizedBytes(uploaded.value.record.id, s.uploaderId);
    expect(r.ok).toBe(true);
  });

  it("getDocument rejects an ordinary MEMBER who is neither owner nor uploader", async () => {
    const s = seed();
    const uploaded = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: makeBytes("get-doc"),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const r = await service.getDocument(uploaded.value.record.id, s.memberId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("DOCUMENT_FORBIDDEN");
  });

  it("getDocument allows a persisted OWNER to read another member's document metadata", async () => {
    const s = seed();
    const uploaded = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: makeBytes("owner-cross-meta"),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const r = await service.getDocument(uploaded.value.record.id, s.otherId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).not.toBeNull();
    expect(r.value?.id).toBe(uploaded.value.record.id);
  });

  it("listByOwner rejects a requester who is not the owner", async () => {
    const s = seed();
    const r = await service.listByOwner(s.ownerId, s.otherId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("DOCUMENT_FORBIDDEN");
  });

  it("listByOwner returns the owner's documents newest first", async () => {
    const s = seed();
    for (let i = 0; i < 3; i++) {
      const u = await service.uploadDocument({
        kind: "RECEIPT",
        ownerMemberId: s.ownerId,
        uploaderMemberId: s.ownerId,
        contentType: "image/jpeg",
        bytes: makeBytes(`list-${i}`),
      });
      expect(u.ok).toBe(true);
    }
    const r = await service.listByOwner(s.ownerId, s.ownerId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(3);
    // Newest first by id DESC.
    const ids = r.value.map((d) => d.id);
    const sorted = [...ids].sort((a, b) => b - a);
    expect(ids).toEqual(sorted);
  });

  it("listByOwner applies limit when provided", async () => {
    const s = seed();
    for (let i = 0; i < 4; i++) {
      const u = await service.uploadDocument({
        kind: "RECEIPT",
        ownerMemberId: s.ownerId,
        uploaderMemberId: s.ownerId,
        contentType: "image/jpeg",
        bytes: makeBytes(`limit-${i}`),
      });
      expect(u.ok).toBe(true);
    }
    const r = await service.listByOwner(s.ownerId, s.ownerId, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
  });
});

// ── Input validation ────────────────────────────────────────────────────────

describe("input validation", () => {
  it("rejects unsupported content-type with INVALID_INPUT", async () => {
    const s = seed();
    const r = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/zip",
      bytes: makeBytes("bad-ct"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(await countDocs()).toBe(0);
  });

  it("rejects empty bytes with INVALID_INPUT", async () => {
    const s = seed();
    const r = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: new Uint8Array(0),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects oversized bytes with INVALID_INPUT", async () => {
    const s = seed();
    const big = new Uint8Array(26 * 1024 * 1024);
    const r = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: big,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects non-positive owner id with INVALID_INPUT", async () => {
    const r = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: 0,
      uploaderMemberId: 1,
      contentType: "application/pdf",
      bytes: makeBytes("zero-owner"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects non-safe-integer member id with INVALID_INPUT", async () => {
    const r = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: 1.5,
      uploaderMemberId: 1,
      contentType: "application/pdf",
      bytes: makeBytes("float-id"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects non-positive document id in getAuthorizedBytes with INVALID_INPUT", async () => {
    const s = seed();
    const r = await service.getAuthorizedBytes(0, s.ownerId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("getAuthorizedBytes returns DOCUMENT_NOT_FOUND for an unknown id", async () => {
    const s = seed();
    const r = await service.getAuthorizedBytes(9_999_999, s.ownerId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("getAuthorizedBytes rejects an inactive requester with MEMBER_INACTIVE", async () => {
    const s = seed();
    const uploaded = await service.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.ownerId,
      contentType: "application/pdf",
      bytes: makeBytes("inactive-read"),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const r = await service.getAuthorizedBytes(uploaded.value.record.id, s.inactiveId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MEMBER_INACTIVE");
  });
});

// ── Failure injection & compensation ────────────────────────────────────────

describe("failure injection", () => {
  it("storage.put failure leaves no metadata row and surfaces INTERNAL", async () => {
    const s = seed();
    const failing = new FailingStorageAdapter(storage);
    failing.failPut = true;
    const failingService = new DocumentApplicationService(repo, failing);

    const r = await failingService.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: makeBytes("put-fail"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INTERNAL");
    // No metadata row was inserted.
    expect(await countDocs()).toBe(0);
    // The object_key must NOT appear in the error message (SPEC §11
    // privacy boundary).
    expect(r.error.message).not.toMatch(/m3a\//);
  });

  it("metadata insert failure compensates by deleting only the newly-written object", async () => {
    const s = seed();
    // Wrap the repository so ensureBySha256 throws. The service must
    // catch that error and delete the just-written storage object as
    // compensation. No object_key may appear in the surfaced error.
    const failingRepo: DocumentRepository = {
      ensureBySha256(_input: InsertDocumentInput): Promise<EnsureBySha256Result> {
        throw new Error("forced metadata insert failure");
      },
      findById: (id: number) => repo.findById(id),
      findBySha256: (sha: string) => repo.findBySha256(sha),
      listByOwner: (ownerMemberId: number, limit?: number) => repo.listByOwner(ownerMemberId, limit),
      loadMemberContext: (memberId: number) => repo.loadMemberContext(memberId),
    };
    const failingService = new DocumentApplicationService(failingRepo, storage);

    const before = storage.size;
    const r = await failingService.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: makeBytes("insert-fail"),
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INTERNAL");
    // The just-written object was deleted — net storage change is zero.
    expect(storage.size).toBe(before);
    // No metadata row was persisted (the INSERT threw before commit).
    expect(await countDocs()).toBe(0);
    // The opaque object_key must NEVER appear in error messages.
    expect(r.error.message).not.toMatch(/m3a\//);
  });

  it("error messages never leak the opaque storage object_key", async () => {
    const s = seed();
    // Force a put failure and inspect the surfaced error.
    const failing = new FailingStorageAdapter(storage);
    failing.failPut = true;
    const failingService = new DocumentApplicationService(repo, failing);
    const r = await failingService.uploadDocument({
      kind: "RECEIPT",
      ownerMemberId: s.ownerId,
      uploaderMemberId: s.uploaderId,
      contentType: "application/pdf",
      bytes: makeBytes("leak-check"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).not.toMatch(/m3a\//);
  });
});
