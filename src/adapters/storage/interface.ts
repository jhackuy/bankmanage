/**
 * Document storage adapter interface.
 *
 * Isolates R2 (and any future replacement) from domain/service code.
 * All document access is private — no adapter implementation may return
 * an unrestricted public URL (e.g. an unauthenticated R2 public-bucket URL).
 *
 * See SPEC.md §11 and ADR-001.
 */

export interface StoredDocument {
  /** Application-internal object key (opaque, not a public URL). */
  readonly key: string;
  /** MIME type of the stored document. */
  readonly contentType: string;
  /** Size in bytes. */
  readonly size: number;
  /** ISO-8601 UTC upload timestamp. */
  readonly uploadedAt: string;
  /** Application-controlled metadata bag. */
  readonly metadata: Record<string, string>;
}

export interface DocumentStorageAdapter {
  /**
   * Store a document and return its metadata.
   * The caller supplies an opaque key; the adapter stores the data under that key.
   */
  put(
    key: string,
    data: ReadableStream | ArrayBuffer | Uint8Array,
    options: {
      contentType: string;
      metadata?: Record<string, string>;
    }
  ): Promise<StoredDocument>;

  /**
   * Retrieve a document by key.
   * Returns null if not found.
   */
  get(key: string): Promise<{ body: ReadableStream | null; metadata: StoredDocument } | null>;

  /**
   * Delete a document by key.
   */
  delete(key: string): Promise<void>;

  /**
   * Check whether a document exists.
   */
  exists(key: string): Promise<boolean>;
}
