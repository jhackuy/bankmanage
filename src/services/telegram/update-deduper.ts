/**
 * Idempotent-update deduper for the Telegram webhook handler.
 *
 * SPEC.md §9: "Duplicate button taps must not duplicate financial writes."
 * That requirement applies across both callback_query and message updates.
 *
 * Two implementations live here:
 *   - InMemoryUpdateDeduper — useful in tests and single-isolate contexts;
 *     NOT safe for production because Cloudflare Workers run many
 *     isolates concurrently and isolates are recycled.
 *   - D1UpdateDeduper — production-safe. Backed by a UNIQUE constraint on
 *     update_id in migration 0014. The SQL boundary is the race-safe
 *     claim; in-process state is intentionally absent.
 *
 * The webhook handler treats a seen update_id as a duplicate replay:
 *   - it must NOT re-send messages;
 *   - it may return 200 immediately so Telegram stops retrying.
 *
 * `tryClaim` is async because the D1 implementation must round-trip to the
 * database to honour the UNIQUE constraint. The in-memory implementation
 * still returns a resolved promise so callers do not branch on shape.
 */

export interface UpdateDeduper {
  /** Returns true if this is the first time the id has been seen in the TTL window. */
  tryClaim(updateId: number): Promise<boolean>;
  /**
   * Release a previously-claimed id so a retry can succeed. Called only when
   * downstream processing threw after a successful claim — without this,
   * Telegram's retry would observe `tryClaim === false` and drop the update
   * with no visible result. Idempotent: releasing a non-claimed or already-
   * released id is a no-op.
   */
  release(updateId: number): Promise<void>;
  /** Clear all tracked entries (used by tests; not by the runtime). */
  reset(): void;
  /** Number of currently tracked ids — useful for assertions and capacity tests. */
  readonly size: number;
}

export class InMemoryUpdateDeduper implements UpdateDeduper {
  private readonly _ttlMs: number;
  private readonly _maxSize: number;
  private readonly _store: Map<number, number> = new Map();

  constructor(options: { ttlMs?: number; maxSize?: number } = {}) {
    this._ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000; // 24 hours — generous
    this._maxSize = options.maxSize ?? 4096;
  }

  async tryClaim(updateId: number): Promise<boolean> {
    if (!Number.isSafeInteger(updateId) || updateId <= 0) {
      return false;
    }
    this.evictExpired();
    if (this._store.has(updateId)) {
      return false;
    }
    if (this._store.size >= this._maxSize) {
      // Oldest-first eviction: Telegram update IDs are monotonic, so the
      // first key in iteration order is the oldest.
      const firstKey = this._store.keys().next().value;
      if (firstKey !== undefined) this._store.delete(firstKey);
    }
    this._store.set(updateId, Date.now());
    return true;
  }

  async release(updateId: number): Promise<void> {
    if (!Number.isSafeInteger(updateId) || updateId <= 0) {
      return;
    }
    this._store.delete(updateId);
  }

  reset(): void {
    this._store.clear();
  }

  get size(): number {
    this.evictExpired();
    return this._store.size;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this._ttlMs;
    for (const [id, seenAt] of this._store) {
      if (seenAt < cutoff) this._store.delete(id);
    }
  }
}
