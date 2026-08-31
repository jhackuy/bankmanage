/**
 * r2-fake-adapter.test.ts
 *
 * Verifies that the fake R2 storage adapter:
 * - Stores and retrieves data correctly.
 * - NEVER returns an unrestricted public URL (no https:// bucket URLs).
 * - Signed URLs use an authenticated/internal scheme only.
 * - Rejects invalid expiry values.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeDocumentStorageAdapter } from "../../src/adapters/storage/index.js";

describe("FakeDocumentStorageAdapter", () => {
  let adapter: FakeDocumentStorageAdapter;

  beforeEach(() => {
    adapter = new FakeDocumentStorageAdapter();
  });

  it("stores and retrieves a document", async () => {
    const data = new TextEncoder().encode("test-document-content");
    const stored = await adapter.put("docs/test.txt", data, {
      contentType: "text/plain",
      metadata: { uploadedBy: "test" },
    });

    expect(stored.key).toBe("docs/test.txt");
    expect(stored.contentType).toBe("text/plain");
    expect(stored.size).toBe(data.byteLength);
    expect(stored.metadata["uploadedBy"]).toBe("test");

    const retrieved = await adapter.get("docs/test.txt");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.metadata.key).toBe("docs/test.txt");
  });

  it("returns null for a non-existent key", async () => {
    const result = await adapter.get("does/not/exist.pdf");
    expect(result).toBeNull();
  });

  it("exists() returns true after put, false after delete", async () => {
    const key = "docs/test-exists.pdf";
    expect(await adapter.exists(key)).toBe(false);

    await adapter.put(key, new Uint8Array([1, 2, 3]), { contentType: "application/pdf" });
    expect(await adapter.exists(key)).toBe(true);

    await adapter.delete(key);
    expect(await adapter.exists(key)).toBe(false);
  });

  describe("signedUrl — no public bucket URLs", () => {
    it("returns a fakesigned:// URL, not an https:// URL", async () => {
      await adapter.put("docs/evidence.pdf", new Uint8Array([1]), { contentType: "application/pdf" });
      const url = await adapter.signedUrl("docs/evidence.pdf", 3600);

      // Must NOT start with https:// (which would be a public R2 URL)
      expect(url).not.toMatch(/^https?:\/\//);
      // Must use the internal fake scheme
      expect(url).toMatch(/^fakesigned:\/\//);
    });

    it("signed URL contains the document key", async () => {
      const key = "receipts/2024/abc123.jpg";
      await adapter.put(key, new Uint8Array([1]), { contentType: "image/jpeg" });
      const url = await adapter.signedUrl(key, 60);

      expect(url).toContain(encodeURIComponent(key));
    });

    it("signed URL contains an expiry parameter", async () => {
      await adapter.put("docs/test.pdf", new Uint8Array([1]), { contentType: "application/pdf" });
      const url = await adapter.signedUrl("docs/test.pdf", 300);
      expect(url).toContain("expires=");
    });

    it("rejects zero or negative expiry", async () => {
      await adapter.put("docs/test.pdf", new Uint8Array([1]), { contentType: "application/pdf" });
      await expect(adapter.signedUrl("docs/test.pdf", 0)).rejects.toThrow();
      await expect(adapter.signedUrl("docs/test.pdf", -10)).rejects.toThrow();
    });

    it("rejects expiry longer than 86400 seconds (24 h)", async () => {
      await adapter.put("docs/test.pdf", new Uint8Array([1]), { contentType: "application/pdf" });
      await expect(adapter.signedUrl("docs/test.pdf", 86_401)).rejects.toThrow();
    });

    it("never returns a public R2 bucket domain", async () => {
      await adapter.put("docs/test.pdf", new Uint8Array([1]), { contentType: "application/pdf" });
      const url = await adapter.signedUrl("docs/test.pdf", 600);
      // Common R2 public patterns that must NOT appear
      expect(url).not.toContain("r2.cloudflarestorage.com");
      expect(url).not.toContain("pub-");
      expect(url).not.toContain(".r2.dev");
    });
  });

  it("clear() removes all documents", async () => {
    await adapter.put("a", new Uint8Array([1]), { contentType: "text/plain" });
    await adapter.put("b", new Uint8Array([2]), { contentType: "text/plain" });
    expect(adapter.size).toBe(2);
    adapter.clear();
    expect(adapter.size).toBe(0);
  });
});
