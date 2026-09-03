/**
 * Cloudflare R2 production document storage adapter.
 *
 * Wraps the Cloudflare `R2Bucket` binding behind the `DocumentStorageAdapter`
 * port. R2 objects are private — this adapter NEVER returns or persists an
 * unrestricted public bucket URL. M3A authorized-byte access flows through
 * `get()`; the Worker route verifies the requesting member's identity
 * BEFORE calling the adapter, and the resulting bytes are streamed
 * directly to the client. There is no signed-URL / presigned-URL code
 * path; constructing one would either invent a method the binding does
 * not expose, or produce a public-bucket URL.
 *
 * See SPEC.md §11, ADR-001, and `interface.ts`.
 */

import type { DocumentStorageAdapter, StoredDocument } from "./interface.js";

/** Subset of the Cloudflare `R2Bucket` binding surface used by this adapter. */
interface R2AdapterBucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array | string | Blob | null,
    options?: {
      httpMetadata?: {
        contentType?: string;
        contentLanguage?: string;
        contentDisposition?: string;
        contentEncoding?: string;
        cacheControl?: string;
      };
      customMetadata?: Record<string, string>;
    }
  ): Promise<{
    key: string;
    size: number;
    etag: string;
    uploaded: Date;
  } | null>;
  get(
    key: string,
    options?: {
      range?: { offset?: number; length?: number };
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    }
  ): Promise<{
    key: string;
    size: number;
    etag: string;
    uploaded: Date;
    body: ReadableStream;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
  } | null>;
  head(key: string): Promise<{ key: string; size: number; uploaded: Date } | null>;
  delete(key: string): Promise<void>;
}

export class CloudflareR2DocumentStorageAdapter implements DocumentStorageAdapter {
  constructor(private readonly bucket: R2AdapterBucket) {}

  async put(
    key: string,
    data: ReadableStream | ArrayBuffer | Uint8Array,
    options: { contentType: string; metadata?: Record<string, string> }
  ): Promise<StoredDocument> {
    const putOptions: {
      httpMetadata: { contentType: string };
      customMetadata?: Record<string, string>;
    } = {
      httpMetadata: { contentType: options.contentType },
    };
    if (options.metadata) {
      putOptions.customMetadata = options.metadata;
    }
    const result = await this.bucket.put(key, data, putOptions);
    if (result === null) {
      // Object keys are private. The failure is "R2 did not return a
      // put result"; we do not include the key in the message because
      // that would leak the private key into any caller that surfaces
      // the error.
      throw new Error("R2 put returned no result");
    }
    return {
      key: result.key,
      contentType: options.contentType,
      size: result.size,
      uploadedAt: result.uploaded.toISOString(),
      metadata: options.metadata ?? {},
    };
  }

  async get(key: string): Promise<{ body: ReadableStream | null; metadata: StoredDocument } | null> {
    const obj = await this.bucket.get(key);
    if (obj === null) return null;
    return {
      body: obj.body,
      metadata: {
        key: obj.key,
        contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
        size: obj.size,
        uploadedAt: obj.uploaded.toISOString(),
        metadata: obj.customMetadata ?? {},
      },
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const head = await this.bucket.head(key);
    return head !== null;
  }
}
