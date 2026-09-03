/**
 * Fake in-memory document storage adapter for tests.
 *
 * - Never returns a real R2 URL or any unrestricted public URL.
 * - Authorized bytes flow through `get()`, which the application service
 *   invokes after a member-scoped read. The fake returns the same
 *   in-memory bytes that were stored via `put()`.
 * - No real storage, no real credentials required.
 */

import type { DocumentStorageAdapter, StoredDocument } from "./interface.js";

interface StoredEntry {
  data: Uint8Array;
  metadata: StoredDocument;
}

export class FakeDocumentStorageAdapter implements DocumentStorageAdapter {
  private readonly _store = new Map<string, StoredEntry>();

  async put(
    key: string,
    data: ReadableStream | ArrayBuffer | Uint8Array,
    options: { contentType: string; metadata?: Record<string, string> }
  ): Promise<StoredDocument> {
    let bytes: Uint8Array;
    if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      // ReadableStream — consume it
      const chunks: Uint8Array[] = [];
      const reader = data.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    }

    const storedDoc: StoredDocument = {
      key,
      contentType: options.contentType,
      size: bytes.length,
      uploadedAt: new Date().toISOString(),
      metadata: options.metadata ?? {},
    };

    this._store.set(key, { data: bytes, metadata: storedDoc });
    return storedDoc;
  }

  async get(key: string): Promise<{ body: ReadableStream | null; metadata: StoredDocument } | null> {
    const entry = this._store.get(key);
    if (!entry) return null;

    const bytes = entry.data;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    return { body: stream, metadata: entry.metadata };
  }

  async delete(key: string): Promise<void> {
    this._store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this._store.has(key);
  }

  /**
   * Test helper: produce an opaque, non-public signed URL identifier.
   *
   * This fake intentionally returns a `fakesigned://` URL — NOT an `https://`
   * R2 public-bucket URL. The real adapter never exposes object keys or
   * presigned URLs; authorized bytes flow through `get()` only.
   */
  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new Error("signedUrl expiry must be a positive number of seconds");
    }
    if (expiresInSeconds > 86_400) {
      throw new Error("signedUrl expiry must not exceed 86400 seconds (24 h)");
    }
    const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(expiresInSeconds);
    return `fakesigned://bankmanage/${encodeURIComponent(key)}?expires=${expiresAt}`;
  }

  /** Test helper: number of stored documents. */
  get size(): number {
    return this._store.size;
  }

  /** Test helper: clear all stored documents. */
  clear(): void {
    this._store.clear();
  }
}
