/**
 * D1-backed update deduper for the Telegram webhook handler.
 *
 * SPEC.md §9: "Duplicate button taps must not duplicate financial writes."
 *
 * Why D1 is required (and the in-memory store is NOT sufficient):
 *
 *   Cloudflare Workers are scheduled across many isolates concurrently. An
 *   in-process Map keyed by update_id only protects against replays that
 *   happen to land on the same isolate. Even within one isolate, isolates
 *   are recycled (≈30s) and any persisted Map is wiped. A retried webhook
 *   may land on a different isolate and observe an empty store.
 *
 *   The race-safe boundary is the UNIQUE constraint on `update_id` declared
 *   in migration 0014_telegram_update_idempotency. We use INSERT OR IGNORE:
 *   exactly one concurrent claim succeeds (changes = 1); all others observe
 *   changes = 0 and report the update_id as already claimed.
 *
 *   Telegram guarantees update_ids are strictly monotonically increasing
 *   per bot, so the "oldest first eviction" property of the in-memory
 *   deduper is naturally satisfied by SQL: any replay is older than the
 *   newest live id, so it is always safe to prune claimed_at < now() - TTL.
 *
 * Concurrency contract:
 *
 *   - `tryClaim(updateId)` is atomic at the SQL level. Two isolates calling
 *     concurrently for the same updateId will see exactly one return true.
 *   - The deduper is fail-closed on DB errors: an exception propagates so the
 *     webhook returns 5xx and Telegram retries — we never silently accept a
 *     potentially-duplicated update.
 *
 * Retention:
 *
 *   The cron worker is responsible for pruning rows older than the TTL
 *   window. The deduper itself never deletes; it only claims.
 */

import type { D1Database } from "../../adapters/d1/types.js";
import type { UpdateDeduper } from "./update-deduper.js";

const CLAIM_SQL = "INSERT OR IGNORE INTO telegram_update_idempotency (update_id) VALUES (?)";

export class D1UpdateDeduper implements UpdateDeduper {
  constructor(private readonly db: D1Database) {}

  async tryClaim(updateId: number): Promise<boolean> {
    if (!Number.isSafeInteger(updateId) || updateId <= 0) {
      return false;
    }
    const result = await this.db.prepare(CLAIM_SQL).bind(updateId).run();
    // D1 returns success: boolean and meta.changes: number. The D1Database
    // type in adapters/d1/types.ts mirrors that contract. We accept either
    // form so this is portable across the Cloudflare binding and the
    // vitest fake-D1 adapter.
    const claimed = readMetaChanges(result);
    return claimed === 1;
  }

  reset(): void {
    // No-op: the D1 deduper has no in-process state. Exposed for tests
    // that share an instance across cases; those tests must TRUNCATE
    // telegram_update_idempotency in their setup instead.
  }

  get size(): number {
    return 0;
  }
}

/**
 * Read `meta.changes` from a D1 prepared-statement result, tolerating the
 * two shapes (Cloudflare runtime and the vitest fake) we have seen.
 */
function readMetaChanges(result: unknown): number {
  if (result === null || typeof result !== "object") return 0;
  const rec = result as Record<string, unknown>;
  const meta = rec["meta"];
  if (meta === null || typeof meta !== "object") return 0;
  const changes = (meta as Record<string, unknown>)["changes"];
  return typeof changes === "number" ? changes : 0;
}
