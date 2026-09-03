/**
 * Internal types shared between the reconciliation repository port and
 * its D1 adapter. Kept in a small dedicated module so the public barrel
 * does not leak `EnsureReconciliationInput` to consumers — that payload
 * is a service-to-repository contract, not a caller-facing input.
 */

import type { ReconciliationRecord } from "./types.js";

/**
 * Insertion payload for `ensureReconciliation`. The service computes
 * `clearedBalanceMinor` and `differenceMinor` from the account's
 * opening_balance + summed ledger entries before calling the repository,
 * so the row is persisted with the snapshot already determined.
 *
 * `currencyCode` is the account's currency at write time — stored
 * explicitly on the row to make the snapshot self-describing for audit
 * and to enforce "different currencies are never aggregated".
 */
export interface EnsureReconciliationInput {
  readonly accountId: number;
  readonly memberId: number;
  readonly currencyCode: string;
  readonly bankConfirmedBalanceMinor: number;
  readonly clearedBalanceMinor: number;
  readonly differenceMinor: number;
  readonly confirmedAt: string;
  readonly evidenceRef: string | null;
  readonly idempotencyKey: string;
}

/**
 * Result of an idempotent reconciliation insert.
 *
 * `created` comes from the database WRITE result of this call, not from
 * a prior read. That makes it race-safe: when two writers attempt to
 * insert the same idempotency_key concurrently, exactly one observes
 * `created: true`, so audit and downstream consumers can tell which
 * caller actually recorded the fact.
 */
export interface EnsureReconciliationResult {
  readonly record: ReconciliationRecord;
  readonly created: boolean;
}
