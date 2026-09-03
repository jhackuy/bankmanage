/**
 * Transactions application service.
 *
 * Platform-neutral orchestration. Implements SPEC §7 (posting, immutability,
 * reversal traceability) and SPEC §6.1 (favorites rise to the front).
 *
 * Responsibilities:
 *   - Build balanced ledger entries from a posting input.
 *   - Enforce positive safe-integer amounts, valid account/category
 *     references, active-account rules and currency compatibility.
 *   - Reject cross-currency transactions (no multi-currency posting in
 *     M2A; transfers within a single currency only).
 *   - Use the idempotency_key UNIQUE constraint as the race-safe boundary
 *     for duplicate posts (delegated to the repository).
 *   - Detect idempotency-key reuse with a DIFFERENT immutable request
 *     identity and return a typed IDEMPOTENCY_CONFLICT — silently
 *     returning the prior transaction on a conflicting payload would
 *     hide a client error and corrupt the audit trail.
 *   - For TRANSFER: emit two account-side entries with opposite signs.
 *     This structurally prevents TRANSFER from being counted as income
 *     or expense by any aggregation that filters on category_id IS NOT NULL.
 *   - For REVERSAL: never physically delete. Insert a NEW transaction
 *     with the opposite-signed entries (mirroring the original) and a
 *     row in transaction_reversals linking it to the original. Mark the
 *     original REVERSED. The reversal IS a transaction itself, so it has
 *     its own idempotency_key derived from the original. Retries of a
 *     reversal are idempotent: re-finding the existing reversal
 *     succeeds and returns it; a concurrent reverser's race is resolved
 *     by checking the linkage row before declaring failure.
 *
 * The service depends on the abstract `TransactionsRepository` port and
 * lightweight `AccountReadRepository` / `CategoryReadRepository` ports
 * for state checks. No platform-specific D1 types leak out of this module.
 */

import type { LedgerDirection, TransactionType } from "../../domain/ledger/index.js";
import type { AccountRepository } from "../accounts/repository.js";
import type { CategoryRepository } from "../categories/repository.js";
import type { NewLedgerEntry, TransactionsRepository } from "./repository.js";
import {
  fail,
  ok,
  type LedgerEntryRecord,
  type PostIncomeExpenseInput,
  type PostTransferInput,
  type ReverseTransactionInput,
  type ServiceResult,
  type TransactionRecord,
  type TransactionWithEntries,
} from "./types.js";

// ── Service ──────────────────────────────────────────────────────────────────

export class TransactionApplicationService {
  constructor(
    private readonly txRepo: TransactionsRepository,
    private readonly accountRepo: AccountRepository,
    private readonly categoryRepo: CategoryRepository
  ) {}

  // ── Posting ────────────────────────────────────────────────────────────────

  /**
   * Post an INCOME or EXPENSE transaction.
   *
   * INCOME: account DEBIT (cash in), category CREDIT (income source).
   * EXPENSE: account CREDIT (cash out), category DEBIT (expense bucket).
   *
   * Both INCOME and EXPENSE require a categoryId (enforced by the XOR
   * CHECK constraint on ledger_entries — one side MUST be an account
   * and the other a category for every balanced post).
   *
   * The account must be owned by `input.memberId`. Cross-member posts
   * (posting against another member's account by ID) are rejected at
   * the service boundary.
   */
  async postIncomeExpense(
    type: "INCOME" | "EXPENSE",
    input: PostIncomeExpenseInput
  ): Promise<ServiceResult<TransactionWithEntries>> {
    const validation = validateAmountAndDate(input.amountMinor, input.occurredOn, input.idempotencyKey);
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
    if (account.currencyCode !== input.currencyCode) {
      return fail(
        "CURRENCY_MISMATCH",
        `account currency ${account.currencyCode} does not match transaction currency ${input.currencyCode}`
      );
    }

    // Both INCOME and EXPENSE require a categoryId — enforced by the
    // application service so the category-side ledger entry has a
    // non-null category_id (the DB XOR constraint only enforces that
    // exactly one of {account_id, category_id} is set per entry; it
    // does not force a category-side entry to exist).
    if (input.categoryId === undefined || input.categoryId === null) {
      return fail("INVALID_INPUT", `${type.toLowerCase()} transactions require a category`);
    }
    const categoryId = input.categoryId;
    const category = await this.categoryRepo.loadCategoryContext(categoryId);
    if (category === null) {
      return fail("CATEGORY_NOT_FOUND", `category ${categoryId} not found`);
    }
    if (category.active === 0) {
      return fail("CATEGORY_INACTIVE", `category ${categoryId} is inactive`);
    }

    const entries = buildIncomeExpenseEntries(type, input, account.accountId, categoryId);

    const result = await this.txRepo.postTransaction({
      transaction: {
        memberId: input.memberId,
        transactionType: type,
        currencyCode: input.currencyCode,
        amountMinor: input.amountMinor,
        occurredOn: input.occurredOn,
        description: input.description ?? null,
        idempotencyKey: input.idempotencyKey,
        sourceEvidenceRef: input.sourceEvidenceRef ?? null,
      },
      entries,
    });

    // Idempotency-key reuse with a DIFFERENT immutable request identity
    // is a typed conflict — silently returning the old transaction would
    // hide a client bug and break audit traceability.
    if (!result.created) {
      const inputIdentity = incomeExpenseRequestIdentity(type, input);
      const storedIdentity = storedTransactionIdentity(result.transaction, result.entries);
      if (inputIdentity !== storedIdentity) {
        return fail(
          "IDEMPOTENCY_CONFLICT",
          `idempotency key "${input.idempotencyKey}" reused with a different ${type.toLowerCase()} payload`
        );
      }
    }

    if (categoryId !== null && result.created) {
      // Favorites rise to the front: best-effort. We do not surface a
      // failure here because the transaction is already posted; the
      // favorite is presentation metadata, not ledger truth.
      // Only bump use_count on a fresh post — idempotent retries
      // (created=false) must not inflate the per-member favorite count,
      // since no new financial fact was posted.
      try {
        await this.categoryRepo.recordCategoryUse(input.memberId, categoryId);
      } catch {
        // best-effort; favorites are not ledger truth
      }
    }

    return ok({
      transaction: result.transaction,
      entries: result.entries,
      created: result.created,
    });
  }

  /**
   * Post a TRANSFER between two user accounts in the SAME currency.
   *
   * Source: CREDIT (money leaves).
   * Destination: DEBIT (money arrives).
   *
   * Both entries reference an account (account_id IS NOT NULL,
   * category_id IS NULL). This structurally distinguishes a transfer from
   * an income or expense in any aggregation: the (account_id IS NOT NULL)
   * AND (category_id IS NULL) shape never matches income/expense rows.
   *
   * Cross-currency transfers are rejected: SPEC §7 requires every
   * transaction to balance within a single currency, and M2A does not
   * ship an FX-rate or multi-currency conversion boundary.
   *
   * Both accounts must be owned by `input.memberId`.
   */
  async postTransfer(input: PostTransferInput): Promise<ServiceResult<TransactionWithEntries>> {
    const validation = validateAmountAndDate(input.amountMinor, input.occurredOn, input.idempotencyKey);
    if (!validation.ok) return validation;
    const memberCheck = await this.requireActiveMember(input.memberId);
    if (!memberCheck.ok) return memberCheck;

    if (input.sourceAccountId === input.destinationAccountId) {
      return fail("INVALID_INPUT", "source and destination accounts must differ");
    }

    const source = await this.accountRepo.loadAccountContext(input.sourceAccountId);
    if (source === null) {
      return fail("ACCOUNT_NOT_FOUND", `source account ${input.sourceAccountId} not found`);
    }
    if (source.memberId !== input.memberId) {
      return fail(
        "ACCOUNT_FORBIDDEN",
        `source account ${input.sourceAccountId} is not owned by member ${input.memberId}`
      );
    }
    if (source.active === 0) {
      return fail("ACCOUNT_INACTIVE", `source account ${input.sourceAccountId} is inactive`);
    }
    if (source.archived === 1) {
      return fail("ACCOUNT_INACTIVE", `source account ${input.sourceAccountId} is archived`);
    }

    const destination = await this.accountRepo.loadAccountContext(input.destinationAccountId);
    if (destination === null) {
      return fail("ACCOUNT_NOT_FOUND", `destination account ${input.destinationAccountId} not found`);
    }
    if (destination.memberId !== input.memberId) {
      return fail(
        "ACCOUNT_FORBIDDEN",
        `destination account ${input.destinationAccountId} is not owned by member ${input.memberId}`
      );
    }
    if (destination.active === 0) {
      return fail("ACCOUNT_INACTIVE", `destination account ${input.destinationAccountId} is inactive`);
    }
    if (destination.archived === 1) {
      return fail("ACCOUNT_INACTIVE", `destination account ${input.destinationAccountId} is archived`);
    }

    // Order of checks matters for the error code. The CROSS_CURRENCY_REJECTED
    // code denotes "the two accounts disagree on currency" — checked FIRST
    // so an M2A reject is distinguishable from "you told us the wrong
    // currency" (CURRENCY_MISMATCH). After both accounts agree, we then
    // verify they match the input currencyCode.
    if (source.currencyCode !== destination.currencyCode) {
      return fail(
        "CROSS_CURRENCY_REJECTED",
        `cross-currency transfers are not supported (${source.currencyCode} -> ${destination.currencyCode})`
      );
    }
    if (source.currencyCode !== input.currencyCode) {
      return fail(
        "CURRENCY_MISMATCH",
        `account currency ${source.currencyCode} does not match transaction currency ${input.currencyCode}`
      );
    }

    const entries = buildTransferEntries(input, source.accountId, destination.accountId);

    const result = await this.txRepo.postTransaction({
      transaction: {
        memberId: input.memberId,
        transactionType: "TRANSFER",
        currencyCode: input.currencyCode,
        amountMinor: input.amountMinor,
        occurredOn: input.occurredOn,
        description: input.description ?? null,
        idempotencyKey: input.idempotencyKey,
        sourceEvidenceRef: input.sourceEvidenceRef ?? null,
      },
      entries,
    });

    if (!result.created) {
      const inputIdentity = transferRequestIdentity(input);
      const storedIdentity = storedTransactionIdentity(result.transaction, result.entries);
      if (inputIdentity !== storedIdentity) {
        return fail(
          "IDEMPOTENCY_CONFLICT",
          `idempotency key "${input.idempotencyKey}" reused with a different transfer payload`
        );
      }
    }

    return ok({
      transaction: result.transaction,
      entries: result.entries,
      created: result.created,
    });
  }

  // ── Reversal ───────────────────────────────────────────────────────────────

  /**
   * Reverse a posted transaction. SPEC §7 immutability: never physically
   * delete. Instead:
   *
   *   1. Insert a NEW transaction whose entries mirror the originals
   *      with opposite directions (DEBIT <-> CREDIT). The reversal
   *      transaction has its own idempotency_key derived from the
   *      original's key so retries are race-safe.
   *   2. Insert a transaction_reversals row linking the original and
   *      the reversal.
   *   3. Mark the original REVERSED.
   *
   * The reversal transaction itself can be reversed only by another
   * reversal — but M2A does not expose double-reversal semantics: a
   * REVERSED transaction cannot be reversed again.
   *
   * Concurrency: this method is idempotent on retry AND race-safe under
   * a concurrent reversal. If an existing reversal is already linked to
   * the original, we return that reversal as success. If a concurrent
   * caller posts a reversal between our read and write (UNIQUE collision
   * on the derived reversal key), we look up the winner and return it.
   */
  async reverseTransaction(input: ReverseTransactionInput): Promise<ServiceResult<TransactionWithEntries>> {
    if (!Number.isSafeInteger(input.transactionId) || input.transactionId <= 0) {
      return fail("INVALID_INPUT", "transactionId must be a positive safe integer");
    }
    const memberCheck = await this.requireActiveMember(input.reversedByMemberId);
    if (!memberCheck.ok) return memberCheck;

    const original = await this.txRepo.getWithEntries(input.transactionId);
    if (original === null) {
      return fail("TRANSACTION_NOT_FOUND", `transaction ${input.transactionId} not found`);
    }
    if (original.transaction.state === "REVERSED") {
      // Idempotent retry: re-finding the existing reversal linkage
      // turns this into a successful no-op so retries see identical
      // 200 responses.
      const existing = await this.txRepo.findReversalForOriginal(input.transactionId);
      if (existing !== null) {
        const existingReversal = await this.txRepo.getWithEntries(existing.reversalTransactionId);
        if (existingReversal !== null) {
          return ok({
            transaction: existingReversal.transaction,
            entries: existingReversal.entries,
            created: false,
          });
        }
      }
      return fail("TRANSACTION_ALREADY_REVERSED", `transaction ${input.transactionId} is already reversed`);
    }
    if (original.entries.length === 0) {
      return fail("ILLEGAL_TRANSITION", `transaction ${input.transactionId} has no ledger entries`);
    }

    const reversalKey = `reversal:${original.transaction.idempotencyKey}`;
    const reversalEntries = original.entries.map((e) => mirrorEntryForReversal(e));

    let posted;
    try {
      posted = await this.txRepo.postTransaction({
        transaction: {
          memberId: original.transaction.memberId,
          transactionType: original.transaction.transactionType,
          currencyCode: original.transaction.currencyCode,
          amountMinor: original.transaction.amountMinor,
          occurredOn: original.transaction.occurredOn,
          description: `Reversal of #${original.transaction.id}`,
          idempotencyKey: reversalKey,
          sourceEvidenceRef: original.transaction.sourceEvidenceRef,
        },
        entries: reversalEntries,
      });
    } catch (err) {
      // The reversalKey is derived from a single source (the original
      // idempotency_key), so a UNIQUE collision here means another
      // concurrent caller reversed it. Re-find the existing reversal
      // and return it (idempotent).
      if (
        err instanceof Error &&
        /UNIQUE constraint failed: transactions\.idempotency_key/i.test(err.message)
      ) {
        const existing = await this.txRepo.findReversalForOriginal(input.transactionId);
        if (existing !== null) {
          const existingReversal = await this.txRepo.getWithEntries(existing.reversalTransactionId);
          if (existingReversal !== null) {
            return ok({
              transaction: existingReversal.transaction,
              entries: existingReversal.entries,
              created: false,
            });
          }
        }
        return fail(
          "DUPLICATE_IDEMPOTENCY_KEY",
          `reversal key already exists for transaction ${input.transactionId}`
        );
      }
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to post reversal");
    }

    // Link the reversal, then mark the original REVERSED.
    try {
      await this.txRepo.insertReversal(
        original.transaction.id,
        posted.transaction.id,
        input.reversedByMemberId,
        input.reason ?? null
      );
    } catch (err) {
      // If a UNIQUE collision on original_transaction_id or
      // reversal_transaction_id, this reversal was already linked —
      // that's fine, fall through. Any other error: the reversal
      // header exists but the linkage does not; clean up to leave zero
      // partial state and surface the failure.
      if (
        err instanceof Error &&
        /UNIQUE constraint failed: transaction_reversals\.(original|reversal)_transaction_id/i.test(
          err.message
        )
      ) {
        // Fall through to markReversed.
      } else {
        await this.cleanupOrphanReversal(posted.transaction.id, posted.transaction.idempotencyKey);
        return fail("INTERNAL", err instanceof Error ? err.message : "Unable to record reversal linkage");
      }
    }

    // Race-safe transition: only POSTED -> REVERSED succeeds. If our
    // markReversed returns null, a concurrent caller already moved the
    // original to REVERSED. The reversal linkage row is the source of
    // truth: if the winner's reversal_transaction_id matches what we
    // just posted, this caller's reversal is in place (idempotent
    // success). If it doesn't match, another caller's reversal is
    // linked; we return that one.
    const marked = await this.txRepo.markReversed(original.transaction.id);
    if (marked === null) {
      const existing = await this.txRepo.findReversalForOriginal(input.transactionId);
      if (existing !== null && existing.reversalTransactionId === posted.transaction.id) {
        return ok({
          transaction: posted.transaction,
          entries: posted.entries,
          created: posted.created,
        });
      }
      if (existing !== null) {
        const winner = await this.txRepo.getWithEntries(existing.reversalTransactionId);
        if (winner !== null) {
          return ok({
            transaction: winner.transaction,
            entries: winner.entries,
            created: false,
          });
        }
      }
      return fail("TRANSACTION_ALREADY_REVERSED", `transaction ${input.transactionId} is already reversed`);
    }

    return ok({
      transaction: posted.transaction,
      entries: posted.entries,
      created: posted.created,
    });
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getTransaction(id: number): Promise<ServiceResult<TransactionWithEntries | null>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "transactionId must be a positive safe integer");
    }
    return ok(await this.txRepo.getWithEntries(id));
  }

  async listTransactionsForMember(
    memberId: number,
    filter?: { readonly transactionType?: TransactionType; readonly state?: string }
  ): Promise<ServiceResult<TransactionRecord[]>> {
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    return ok(await this.txRepo.listByMember(memberId, filter));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

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

  private async cleanupOrphanReversal(transactionId: number, idempotencyKey: string): Promise<void> {
    try {
      await this.txRepo.deleteTransactionAndEntries(transactionId, idempotencyKey);
    } catch {
      // best-effort cleanup; we already failed the call and want to
      // surface the original error
    }
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function validateAmountAndDate(
  amountMinor: number,
  occurredOn: string,
  idempotencyKey: string
): ServiceResult<true> {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return fail("INVALID_INPUT", "amountMinor must be a positive safe integer");
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return fail("INVALID_INPUT", "idempotencyKey must be a non-empty string");
  }
  // Occurred-on must be an ISO-8601 calendar date (YYYY-MM-DD). Time-only
  // or datetime strings are rejected because ledger days are whole-day
  // boundaries.
  if (typeof occurredOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
    return fail("INVALID_INPUT", "occurredOn must be an ISO date (YYYY-MM-DD)");
  }
  const parsed = new Date(`${occurredOn}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return fail("INVALID_INPUT", "occurredOn is not a valid calendar date");
  }
  // Round-trip to catch e.g. 2026-02-31 silently becoming 2026-03-03.
  const back = parsed.toISOString().slice(0, 10);
  if (back !== occurredOn) {
    return fail("INVALID_INPUT", `occurredOn is not a valid calendar date (got ${back})`);
  }
  return ok(true);
}

function buildIncomeExpenseEntries(
  type: "INCOME" | "EXPENSE",
  input: PostIncomeExpenseInput,
  accountId: number,
  categoryId: number
): NewLedgerEntry[] {
  if (type === "INCOME") {
    // Account DEBIT (money in), Category CREDIT (income source).
    return [
      {
        accountId,
        categoryId: null,
        direction: "DEBIT",
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        memo: input.description ?? null,
      },
      {
        accountId: null,
        categoryId,
        direction: "CREDIT",
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        memo: input.description ?? null,
      },
    ];
  }
  // EXPENSE: Account CREDIT (money out), Category DEBIT (expense bucket).
  return [
    {
      accountId,
      categoryId: null,
      direction: "CREDIT",
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      memo: input.description ?? null,
    },
    {
      accountId: null,
      categoryId,
      direction: "DEBIT",
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      memo: input.description ?? null,
    },
  ];
}

function buildTransferEntries(
  input: PostTransferInput,
  sourceAccountId: number,
  destinationAccountId: number
): NewLedgerEntry[] {
  return [
    {
      accountId: sourceAccountId,
      categoryId: null,
      direction: "CREDIT",
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      memo: input.description ?? null,
    },
    {
      accountId: destinationAccountId,
      categoryId: null,
      direction: "DEBIT",
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      memo: input.description ?? null,
    },
  ];
}

function mirrorEntryForReversal(original: LedgerEntryRecord): NewLedgerEntry {
  const flipped: LedgerDirection = original.direction === "DEBIT" ? "CREDIT" : "DEBIT";
  return {
    accountId: original.accountId,
    categoryId: original.categoryId,
    direction: flipped,
    amountMinor: original.amountMinor,
    currencyCode: original.currencyCode,
    memo: `Reversal of entry #${original.id}`,
  };
}

/**
 * Deterministic identity string for an INCOME / EXPENSE posting input.
 * Includes the immutable fields that, taken together, fully describe the
 * post. The same input always produces the same string.
 */
function incomeExpenseRequestIdentity(type: "INCOME" | "EXPENSE", input: PostIncomeExpenseInput): string {
  return [
    type,
    input.memberId,
    input.currencyCode,
    input.amountMinor,
    input.occurredOn,
    input.accountId,
    input.categoryId ?? "null",
  ]
    .map((v) => String(v))
    .join("|");
}

/**
 * Deterministic identity string for a TRANSFER posting input. Same
 * semantics as `incomeExpenseRequestIdentity`.
 */
function transferRequestIdentity(input: PostTransferInput): string {
  return [
    "TRANSFER",
    input.memberId,
    input.currencyCode,
    input.amountMinor,
    input.occurredOn,
    input.sourceAccountId,
    input.destinationAccountId,
  ]
    .map((v) => String(v))
    .join("|");
}

/**
 * Identity rebuilt from a stored transaction + its entries. Mirrors the
 * `*RequestIdentity` helpers so a server-side read yields the same
 * identity string as the original input that produced it.
 *
 * For INCOME/EXPENSE: identifies by transaction type + member + the
 * account on the account-side entry (the entry with accountId non-null)
 * and the category on the category-side entry (the entry with
 * categoryId non-null).
 *
 * For TRANSFER: identifies by the source (CREDIT) and destination (DEBIT)
 * entries — both are account-side so we sort them by direction.
 */
function storedTransactionIdentity(
  transaction: TransactionRecord,
  entries: readonly LedgerEntryRecord[]
): string {
  if (transaction.transactionType === "TRANSFER") {
    const source = entries.find((e) => e.direction === "CREDIT");
    const destination = entries.find((e) => e.direction === "DEBIT");
    return [
      "TRANSFER",
      transaction.memberId,
      transaction.currencyCode,
      transaction.amountMinor,
      transaction.occurredOn,
      source?.accountId ?? "null",
      destination?.accountId ?? "null",
    ]
      .map((v) => String(v))
      .join("|");
  }
  const accountSide = entries.find((e) => e.accountId !== null);
  const categorySide = entries.find((e) => e.categoryId !== null);
  return [
    transaction.transactionType,
    transaction.memberId,
    transaction.currencyCode,
    transaction.amountMinor,
    transaction.occurredOn,
    accountSide?.accountId ?? "null",
    categorySide?.categoryId ?? "null",
  ]
    .map((v) => String(v))
    .join("|");
}
