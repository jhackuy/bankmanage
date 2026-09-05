/**
 * Idempotent-update deduper for the Telegram webhook handler.
 *
 * SPEC.md §9: "Duplicate button taps must not duplicate financial writes."
 * That requirement applies across both callback_query and message updates.
 *
 * Cloudflare Workers run as many independent isolates as the runtime
 * decides, but a single isolate observes update_ids strictly in
 * monotonically increasing order from Telegram. The cheapest correct
 * dedup at the webhook boundary is therefore an in-memory LRU-ish map
 * keyed by update_id with a TTL window (just larger than the longest
 * plausible retry interval).
 *
 * The webhook handler treats a seen update_id as a duplicate replay:
 *   - it must NOT re-send messages;
 *   - it may return 200 immediately so Telegram stops retrying.
 *
 * If two workers observe the same update concurrently, the existing
 * transaction idempotency inside the deposit / ledger services (UNIQUE
 * (deposit_id, offset_kind) etc.) is the second line of defence.
 */

export interface UpdateDeduper {
  /** Returns true if this is the first time the id has been seen in the TTL window. */
  tryClaim(updateId: number): boolean;
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

  tryClaim(updateId: number): boolean {
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
