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
 *      is computed in the account's currency only, and a request that
 *      declares a different currency is rejected with CURRENCY_MISMATCH.
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
 * Timestamp canonicalization:
 *   - `confirmedAt` is validated as a real ISO-8601 instant and then
 *     canonicalized to UTC ("YYYY-MM-DDTHH:MM:SS.sssZ"). The stored row
 *     uses the canonical form, so SQL string ordering on `confirmed_at`
 *     is correct regardless of the caller's submitted offset. The
 *     idempotency identity uses the canonical form too, so mixed-offset
 *     retries of the same instant collapse to the same identity.
 *
 * Immutability / history:
 *   - Reconciliations are append-only. The cleared balance and
 *     difference are stored at write time as an immutable snapshot so
 *     historical audit reflects what was true at the moment of
 *     confirmation.
 *   - Posted ledger facts are never mutated by the reconciliation flow.
 *
 * Authorization (SPEC §2 two-user model):
 *   - Writes reject cross-member reconciliations (ACCOUNT_FORBIDDEN).
 *   - Inactive members and inactive / archived accounts are rejected.
 *   - Reads are member-scoped: every read takes the requesting
 *     `memberId` and rejects access to reconciliations owned by a
 *     different member.
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
    const canonicalConfirmedAt = validation.value;

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
    if (input.currencyCode !== undefined && input.currencyCode !== account.currencyCode) {
      return fail(
        "CURRENCY_MISMATCH",
        `account currency ${account.currencyCode} does not match request currency ${input.currencyCode}`
      );
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
        confirmedAt: canonicalConfirmedAt,
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
      const inputIdentity = reconciliationRequestIdentity(input, canonicalConfirmedAt);
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

  async getReconciliation(id: number, memberId: number): Promise<ServiceResult<ReconciliationRecord | null>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "reconciliation id must be a positive safe integer");
    }
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    const memberCheck = await this.requireActiveMember(memberId);
    if (!memberCheck.ok) return memberCheck;
    const record = await this.repo.findById(id);
    if (record !== null && record.memberId !== memberId) {
      return fail("ACCOUNT_FORBIDDEN", `reconciliation ${id} is not owned by member ${memberId}`);
    }
    return ok(record);
  }

  async getLatestForAccount(
    accountId: number,
    memberId: number
  ): Promise<ServiceResult<ReconciliationRecord | null>> {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      return fail("INVALID_INPUT", "accountId must be a positive safe integer");
    }
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    const memberCheck = await this.requireActiveMember(memberId);
    if (!memberCheck.ok) return memberCheck;
    const account = await this.accountRepo.loadAccountContext(accountId);
    if (account === null) {
      return fail("ACCOUNT_NOT_FOUND", `account ${accountId} not found`);
    }
    if (account.memberId !== memberId) {
      return fail("ACCOUNT_FORBIDDEN", `account ${accountId} is not owned by member ${memberId}`);
    }
    return ok(await this.repo.getLatestForAccount(accountId));
  }

  async listForAccount(
    accountId: number,
    memberId: number,
    limit?: number
  ): Promise<ServiceResult<ReconciliationRecord[]>> {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      return fail("INVALID_INPUT", "accountId must be a positive safe integer");
    }
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      return fail("INVALID_INPUT", "limit must be a positive safe integer when provided");
    }
    const memberCheck = await this.requireActiveMember(memberId);
    if (!memberCheck.ok) return memberCheck;
    const account = await this.accountRepo.loadAccountContext(accountId);
    if (account === null) {
      return fail("ACCOUNT_NOT_FOUND", `account ${accountId} not found`);
    }
    if (account.memberId !== memberId) {
      return fail("ACCOUNT_FORBIDDEN", `account ${accountId} is not owned by member ${memberId}`);
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

/**
 * Validate `PostReconciliationInput` and return the canonical UTC
 * `confirmedAt` to use for persistence and identity comparison. The
 * canonical form ("YYYY-MM-DDTHH:MM:SS.sssZ") makes SQL string ordering
 * correct for mixed-offset instants.
 */
function validateInput(input: PostReconciliationInput): ServiceResult<string> {
  if (!Number.isSafeInteger(input.memberId) || input.memberId <= 0) {
    return fail("INVALID_INPUT", "memberId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.accountId) || input.accountId <= 0) {
    return fail("INVALID_INPUT", "accountId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.bankConfirmedBalanceMinor)) {
    return fail("INVALID_INPUT", "bankConfirmedBalanceMinor must be a safe integer");
  }
  if (input.currencyCode !== undefined) {
    if (typeof input.currencyCode !== "string" || input.currencyCode.length === 0) {
      return fail("INVALID_INPUT", "currencyCode must be a non-empty string when provided");
    }
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
  const [, yStr, moStr, dStr, hStr, miStr, sStr] = dateMatch;
  const year = Number(yStr);
  const month = Number(moStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(miStr);
  const second = Number(sStr);
  if (month < 1 || month > 12) {
    return fail("INVALID_INPUT", `confirmedAt is not a valid datetime: ${input.confirmedAt}`);
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) {
    return fail("INVALID_INPUT", `confirmedAt is not a valid datetime: ${input.confirmedAt}`);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return fail("INVALID_INPUT", `confirmedAt is not a valid datetime: ${input.confirmedAt}`);
  }
  const parsed = new Date(input.confirmedAt);
  if (Number.isNaN(parsed.getTime())) {
    return fail("INVALID_INPUT", `confirmedAt is not a valid datetime: ${input.confirmedAt}`);
  }
  // Canonicalize to UTC ISO-8601 so mixed-offset instants collapse to
  // the same storage form. This is what gets written to the row and
  // used in the idempotency identity, so SQL string ordering on
  // `confirmed_at` is correct for any offset the caller submitted.
  const canonical = parsed.toISOString();
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
    return fail("INVALID_INPUT", "idempotencyKey must be a non-empty string");
  }
  if (input.evidenceRef !== undefined && typeof input.evidenceRef !== "string") {
    return fail("INVALID_INPUT", "evidenceRef must be a string when provided");
  }
  return ok(canonical);
}

/**
 * Deterministic identity string for a reconciliation posting input.
 * Includes the immutable fields that, taken together, fully describe the
 * bank-confirmed payload. The cleared_balance and difference are
 * computed from the ledger snapshot at write time and are NOT part of
 * the input identity — a retry of the same bank payload must yield the
 * stored record (created=false), even if the ledger has since changed.
 *
 * `confirmedAt` is compared in canonical UTC form. `currencyCode` is
 * the caller-declared currency as supplied (or the empty string when
 * omitted) — NOT the account's currency, so a retry that omits
 * `currencyCode` produces a different identity from a prior write that
 * declared it. The service validates that the declared currency (when
 * present) matches the account's currency upstream.
 */
function reconciliationRequestIdentity(input: PostReconciliationInput, canonicalConfirmedAt: string): string {
  return [
    input.accountId,
    input.currencyCode ?? "",
    input.bankConfirmedBalanceMinor,
    canonicalConfirmedAt,
    input.evidenceRef ?? "null",
  ]
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
 * `confirmedAt` is already canonical (the service writes the canonical
 * form) and `currencyCode` is the stored snapshot value.
 */
function storedReconciliationIdentity(record: ReconciliationRecord): string {
  return [
    record.accountId,
    record.currencyCode,
    record.bankConfirmedBalanceMinor,
    record.confirmedAt,
    record.evidenceRef ?? "null",
  ]
    .map((v) => String(v))
    .join("|");
}

// ── Helper: re-export serviceError for callers that want to log codes ───────

export { serviceError };
