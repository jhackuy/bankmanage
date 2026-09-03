/**
 * Reconciliation repository interface.
 *
 * Application service depends on this abstract port. The D1 adapter in
 * `./d1-repository.ts` provides the production implementation; tests use
 * the same port against the FakeD1Database binding.
 *
 * The repository is responsible for:
 *   - idempotent insertion keyed on UNIQUE (idempotency_key);
 *   - deterministic row-to-domain mapping (no JS floating point on money);
 *   - parameterized SQL only;
 *   - cleared-balance computation in integer minor units.
 *
 * The repository does NOT:
 *   - validate business invariants (those live in the application service);
 *   - compute or override the reconciliation difference (the service
 *     snapshots cleared_balance + difference at write time, the repository
 *     persists them verbatim).
 */

import type { EnsureReconciliationInput, EnsureReconciliationResult } from "./internal-types.js";
import type { ReconciliationRecord } from "./types.js";

export type { EnsureReconciliationInput, EnsureReconciliationResult } from "./internal-types.js";
export { type ReconciliationRecord } from "./types.js";

export interface ReconciliationRepository {
  /**
   * Idempotently insert a reconciliation row. If a row with the same
   * idempotency_key already exists, it is returned unchanged with
   * `created: false`; otherwise the new row is inserted and returned
   * with `created: true`.
   *
   * The UNIQUE (idempotency_key) constraint is the race-safe boundary:
   * concurrent reconciliation writers cannot create duplicates, and
   * only the caller whose INSERT actually wrote the row observes
   * `created: true`.
   *
   * Caller MUST have validated business rules (member active, account
   * owned by member, account active/non-archived, safe-integer
   * bankConfirmedBalanceMinor, valid datetime). The repository does
   * not re-check those — it only persists what the service passes.
   */
  ensureReconciliation(input: EnsureReconciliationInput): Promise<EnsureReconciliationResult>;

  /** SELECT a single reconciliation by id. Returns null if no row matches. */
  findById(id: number): Promise<ReconciliationRecord | null>;

  /**
   * SELECT a single reconciliation by idempotency_key. Returns null if
   * no row matches. Used by the application service to surface
   * IDEMPOTENCY_CONFLICT when the same key is reused with a different
   * immutable request identity.
   */
  findByIdempotencyKey(key: string): Promise<ReconciliationRecord | null>;

  /**
   * SELECT all reconciliations for an account, newest first (confirmed_at
   * DESC, id DESC for stable tie-breaks).
   *
   * `limit` caps the result set for callers that render history but do
   * not need the entire audit trail. Pass undefined for the full list.
   */
  listForAccount(accountId: number, limit?: number): Promise<ReconciliationRecord[]>;

  /**
   * SELECT the most-recent reconciliation for an account, or null if
   * the account has never been reconciled. Used by the dashboard's
   * "latest reconciliation status" widget.
   */
  getLatestForAccount(accountId: number): Promise<ReconciliationRecord | null>;

  /**
   * Compute the deterministic cleared ledger balance for an account in
   * integer minor units, filtered to the account's currency.
   *
   * The computation is `opening_balance_minor + Σ(amount × sign)` over
   * every ledger entry where `account_id = ? AND currency_code = ?`.
   * Reversal transactions are included alongside their originals so the
   * pair sums to zero (the original's entries cancel the reversal's
   * mirrored entries). Different currencies are never aggregated.
   *
   * Returns 0 when the account has no ledger entries. The caller is
   * expected to know the account's currency (passed in for symmetry
   * with `account_id` and to enforce the no-aggregation rule).
   */
  computeClearedBalanceMinor(accountId: number, currencyCode: string): Promise<number>;
}
