/**
 * Reconciliation application service.
 *
 * Platform-neutral orchestration: enforces all business invariants before
 * persistence, computes the deterministic cleared ledger balance via the
 * repository, and persists an immutable reconciliation snapshot. The
 * service depends only on the abstract `ReconciliationRepository` port
 * and the `AccountRepository` port for state checks.
 *
 * SPEC §7 reconciliation contracts enforced here:
 *   - "Reconciliation compares bank-confirmed balance with cleared
 *      ledger balance."
 *   - "A non-zero difference is displayed and never silently repaired
 *      by inserting an adjustment." — the service returns the explicit
 *      `differenceMinor` and never creates a transaction.
 *   - "Different currencies are never aggregated" — the cleared balance
 *      is computed in the account's currency only.
 *
 * Idempotency:
 *   - `idempotency_key` UNIQUE constraint is the race-safe boundary for
 *     the same immutable request.
 *   - Same payload retry: returns the existing record with `created=false`.
 *   - Different payload retry: surfaces as IDEMPOTENCY_CONFLICT —
 *     silently returning the prior record on a conflicting payload would
 *     hide a client bug and break audit traceability (mirrors the
 *     transactions service pattern).
 *
 * Immutability / history:
 *   - Reconciliations are append-only. The cleared balance and
 *     difference are stored at write time as an immutable snapshot so
 *     historical audit reflects what was true at the moment of
 *     confirmation.
 *   - Posted ledger facts are never mutated by the reconciliation flow.
 *
 * Authorization (SPEC §2 two-user model):
 *   - The service rejects cross-member reconciliations (ACCOUNT_FORBIDDEN).
 *   - Inactive members and inactive / archived accounts are rejected.
 */

import type { AccountRepository } from "../accounts/repository.js";
import type { ReconciliationRepository } from "./repository.js";
import {
  fail,
  ok,
  serviceError,
  type PostReconciliationInput,
  type ReconciliationRecord,
  type ServiceResult,
  type UnreconciledAccount,
} from "./types.js";

export interface RecordReconciliationResult {
  readonly record: ReconciliationRecord;
  readonly created: boolean;
}

export class ReconciliationApplicationService {
  constructor(
    private readonly repo: ReconciliationRepository,
    private readonly accountRepo: AccountRepository
  ) {}

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Record a reconciliation. Returns the canonical record and a `created`
   * flag. A retry with the same immutable request identity returns the
   * existing record with `created: false` (200-style success); a retry
   * with a DIFFERENT payload surfaces IDEMPOTENCY_CONFLICT.
   *
   * Never inserts an adjustment transaction — the difference is
   * surfaced explicitly on the returned record for dashboard / report
   * consumers to display (SPEC §7).
   */
  async recordReconciliation(
    input: PostReconciliationInput
  ): Promise<ServiceResult<RecordReconciliationResult>> {
    const validation = validateInput(input);
    if (!validation.ok) return validation;

    const memberCheck = await this.requireActiveMember(input.memberId);
    if (!memberCheck.ok) return memberCheck;

    const account = await this.accountRepo.loadAccountContext(input.accountId);
    if (account === null) {
      return fail("ACCOUNT_NOT_FOUND", `account ${input.accountId} not found`);
    }
    if (account.memberId !== input.memberId) {
      return fail("ACCOUNT_FORBIDDEN", `account ${input.accountId} is not owned by member ${input.memberId}`);
    }
    if (account.active === 0) {
      return fail("ACCOUNT_INACTIVE", `account ${input.accountId} is inactive`);
    }
    if (account.archived === 1) {
      return fail("ACCOUNT_INACTIVE", `account ${input.accountId} is archived`);
    }

    // Deterministic cleared balance in integer minor units for the
    // account's currency. SPEC §7: different currencies are never
    // aggregated; the WHERE clause on currency_code is enforced at the
    // repository level.
    const clearedBalance = await this.repo.computeClearedBalanceMinor(input.accountId, account.currencyCode);
    if (!Number.isSafeInteger(clearedBalance)) {
      return fail("OVERFLOW", `cleared balance ${clearedBalance} is outside the safe-integer range`);
    }

    // The bank-confirmed balance is a safe integer (checked above).
    // Subtracting two safe integers is always a safe integer, so the
    // difference cannot overflow by itself — but we re-check explicitly
    // to keep the invariant easy to reason about in tests.
    const difference = input.bankConfirmedBalanceMinor - clearedBalance;
    if (!Number.isSafeInteger(difference)) {
      return fail("OVERFLOW", `reconciliation difference ${difference} is outside the safe-integer range`);
    }

    let ensured;
    try {
      ensured = await this.repo.ensureReconciliation({
        accountId: input.accountId,
        memberId: input.memberId,
        currencyCode: account.currencyCode,
        bankConfirmedBalanceMinor: input.bankConfirmedBalanceMinor,
        clearedBalanceMinor: clearedBalance,
        differenceMinor: difference,
        confirmedAt: input.confirmedAt,
        evidenceRef: input.evidenceRef ?? null,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (err) {
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to record reconciliation");
    }

    // Idempotency-key reuse with a DIFFERENT immutable request identity
    // is a typed conflict — silently returning the old record would
    // hide a client bug and break audit traceability.
    if (!ensured.created) {
      const inputIdentity = reconciliationRequestIdentity(input);
      const storedIdentity = storedReconciliationIdentity(ensured.record);
      if (inputIdentity !== storedIdentity) {
        return fail(
          "IDEMPOTENCY_CONFLICT",
          `idempotency key "${input.idempotencyKey}" reused with a different reconciliation payload`
        );
      }
    }

    return ok({ record: ensured.record, created: ensured.created });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async getReconciliation(id: number): Promise<ServiceResult<ReconciliationRecord | null>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "reconciliation id must be a positive safe integer");
    }
    return ok(await this.repo.findById(id));
  }

  async getLatestForAccount(accountId: number): Promise<ServiceResult<ReconciliationRecord | null>> {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      return fail("INVALID_INPUT", "accountId must be a positive safe integer");
    }
    const account = await this.accountRepo.loadAccountContext(accountId);
    if (account === null) {
      return fail("ACCOUNT_NOT_FOUND", `account ${accountId} not found`);
    }
    return ok(await this.repo.getLatestForAccount(accountId));
  }

  async listForAccount(accountId: number, limit?: number): Promise<ServiceResult<ReconciliationRecord[]>> {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      return fail("INVALID_INPUT", "accountId must be a positive safe integer");
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      return fail("INVALID_INPUT", "limit must be a positive safe integer when provided");
    }
    const account = await this.accountRepo.loadAccountContext(accountId);
    if (account === null) {
      return fail("ACCOUNT_NOT_FOUND", `account ${accountId} not found`);
    }
    return ok(await this.repo.listForAccount(accountId, limit));
  }

  /**
   * List every account that is "unreconciled":
   *   - has never been reconciled (no reconciliation record), OR
   *   - its most-recent reconciliation has a non-zero difference.
   *
   * The list is filtered to active, non-archived accounts. If `memberId`
   * is supplied, only that member's accounts are considered.
   *
   * Used by the dashboard's "unreconciled accounts" widget
   * (SPEC §8) and by report consumers.
   */
  async listUnreconciledAccounts(memberId?: number): Promise<ServiceResult<UnreconciledAccount[]>> {
    if (memberId !== undefined) {
      if (!Number.isSafeInteger(memberId) || memberId <= 0) {
        return fail("INVALID_INPUT", "memberId must be a positive safe integer");
      }
      const ctx = await this.accountRepo.loadMemberContext(memberId);
      if (ctx === null) {
        return fail("MEMBER_NOT_FOUND", `member ${memberId} not found`);
      }
    }

    const all =
      memberId === undefined
        ? await this.accountRepo.listAll()
        : await this.accountRepo.listByMember(memberId);
    const active = all.filter((a) => a.active === 1 && a.archived === 0);

    const out: UnreconciledAccount[] = [];
    for (const account of active) {
      const latest = await this.repo.getLatestForAccount(account.id);
      if (latest === null || latest.differenceMinor !== 0) {
        out.push({ account, latestReconciliation: latest });
      }
    }
    return ok(out);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async requireActiveMember(memberId: number): Promise<ServiceResult<true>> {
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    const ctx = await this.accountRepo.loadMemberContext(memberId);
    if (ctx === null) {
      return fail("MEMBER_NOT_FOUND", `member ${memberId} not found`);
    }
    if (ctx.active !== 1) {
      return fail("MEMBER_INACTIVE", `member ${memberId} is inactive`);
    }
    return ok(true);
  }
}

// ── Pure validators / helpers ──────────────────────────────────────────────

function validateInput(input: PostReconciliationInput): ServiceResult<true> {
  if (!Number.isSafeInteger(input.memberId) || input.memberId <= 0) {
    return fail("INVALID_INPUT", "memberId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.accountId) || input.accountId <= 0) {
    return fail("INVALID_INPUT", "accountId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.bankConfirmedBalanceMinor)) {
    return fail("INVALID_INPUT", "bankConfirmedBalanceMinor must be a safe integer");
  }
  if (typeof input.confirmedAt !== "string") {
    return fail("INVALID_INPUT", "confirmedAt must be a string");
  }
  const dateMatch = input.confirmedAt.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/
  );
  if (dateMatch === null) {
    return fail(
      "INVALID_INPUT",
      "confirmedAt must be an ISO-8601 datetime (YYYY-MM-DDTHH:MM:SS[.sss][Z|±HH:MM])"
    );
  }
  // Reject syntactically valid but impossible calendar instants
  // (e.g. "2026-02-30T00:00:00Z"). JavaScript's Date constructor silently
  // rolls overflowed days into the next month, so NaN-checks alone miss
  // this — we must validate the calendar fields directly.
  const [, yStr, moStr, dStr, hStr, miStr, sStr, fracStr] = dateMatch;
  const year = Number(yStr);
  const month = Number(moStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(miStr);
  const second = Number(sStr);
  const fracMs = fracStr === undefined ? 0 : Number(fracStr.padEnd(3, "0").slice(0, 3));
  if (month < 1 || month > 12) {
    return fail("INVALID_INPUT", `confirmedAt is not a valid datetime: ${input.confirmedAt}`);
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) {
    return fail("INVALID_INPUT", `confirmedAt is not a valid datetime: ${input.confirmedAt}`);
  }
  if (hour > 23 || minute > 59 || second > 59 || fracMs > 999) {
    return fail("INVALID_INPUT", `confirmedAt is not a valid datetime: ${input.confirmedAt}`);
  }
  const parsed = new Date(input.confirmedAt);
  if (Number.isNaN(parsed.getTime())) {
    return fail("INVALID_INPUT", `confirmedAt is not a valid datetime: ${input.confirmedAt}`);
  }
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
    return fail("INVALID_INPUT", "idempotencyKey must be a non-empty string");
  }
  if (input.evidenceRef !== undefined && typeof input.evidenceRef !== "string") {
    return fail("INVALID_INPUT", "evidenceRef must be a string when provided");
  }
  return ok(true);
}

/**
 * Deterministic identity string for a reconciliation posting input.
 * Includes the immutable fields that, taken together, fully describe the
 * bank-confirmed payload. The cleared_balance and difference are
 * computed from the ledger snapshot at write time and are NOT part of
 * the input identity — a retry of the same bank payload must yield the
 * stored record (created=false), even if the ledger has since changed.
 */
function reconciliationRequestIdentity(input: PostReconciliationInput): string {
  return [input.accountId, input.bankConfirmedBalanceMinor, input.confirmedAt, input.evidenceRef ?? "null"]
    .map((v) => String(v))
    .join("|");
}

/**
 * Identity rebuilt from a stored reconciliation row. Mirrors
 * `reconciliationRequestIdentity` so a same-payload retry reads back to
 * the same identity string.
 *
 * `clearedBalanceMinor` / `differenceMinor` are NOT included — they
 * belong to the snapshot at write time, not to the request identity.
 */
function storedReconciliationIdentity(record: ReconciliationRecord): string {
  return [
    record.accountId,
    record.bankConfirmedBalanceMinor,
    record.confirmedAt,
    record.evidenceRef ?? "null",
  ]
    .map((v) => String(v))
    .join("|");
}

// ── Helper: re-export serviceError for callers that want to log codes ───────

export { serviceError };
