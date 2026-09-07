/**
 * tests/unit/telegram-update-deduper.test.ts
 *
 * Verifies the in-memory update deduper that prevents a replayed update_id
 * from being handled twice. SPEC.md §9: "Duplicate button taps must not
 * duplicate financial writes."
 */

import { describe, expect, it } from "vitest";
import { InMemoryUpdateDeduper } from "../../src/services/telegram/update-deduper.js";

describe("InMemoryUpdateDeduper", () => {
  it("grants the first claim and rejects subsequent reclaims", async () => {
    const d = new InMemoryUpdateDeduper();
    expect(await d.tryClaim(1)).toBe(true);
    expect(await d.tryClaim(1)).toBe(false);
    expect(await d.tryClaim(1)).toBe(false);
    expect(d.size).toBe(1);
  });

  it("treats non-positive ids as un-claimable", async () => {
    const d = new InMemoryUpdateDeduper();
    expect(await d.tryClaim(0)).toBe(false);
    expect(await d.tryClaim(-5)).toBe(false);
    expect(d.size).toBe(0);
  });

  it("rejects non-safe integers", async () => {
    const d = new InMemoryUpdateDeduper();
    expect(await d.tryClaim(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it("evicts oldest entry once maxSize is exceeded", async () => {
    const d = new InMemoryUpdateDeduper({ maxSize: 3 });
    expect(await d.tryClaim(1)).toBe(true);
    expect(await d.tryClaim(2)).toBe(true);
    expect(await d.tryClaim(3)).toBe(true);
    expect(await d.tryClaim(4)).toBe(true); // overflow evicts 1
    expect(await d.tryClaim(1)).toBe(true); // reclaimable again
    expect(d.size).toBe(3);
  });

  it("reset() clears all tracked ids", async () => {
    const d = new InMemoryUpdateDeduper();
    await d.tryClaim(1);
    await d.tryClaim(2);
    d.reset();
    expect(d.size).toBe(0);
    expect(await d.tryClaim(1)).toBe(true);
  });

  it("expires entries after the TTL elapses", async () => {
    const d = new InMemoryUpdateDeduper({ ttlMs: 100 });
    expect(await d.tryClaim(1)).toBe(true);
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 150);
    });
    expect(await d.tryClaim(1)).toBe(true); // TTL elapsed
    expect(d.size).toBe(1);
  });
});
