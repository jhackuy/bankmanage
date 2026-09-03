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
 *   - For TRANSFER: emit two account-side entries with opposite signs.
 *     This structurally prevents TRANSFER from being counted as income
 *     or expense by any aggregation that filters on category_id IS NOT NULL.
 *   - For REVERSAL: never physically delete. Insert a NEW transaction
 *     with the opposite-signed entries (mirroring the original) and a
 *     row in transaction_reversals linking it to the original. Mark the
 *     original REVERSED. The reversal IS a transaction itself, so it has
 *     its own idempotency_key derived from the original.
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
   * `categoryId` is optional for INCOME (income sources can be unallocated
   * to a category) and required for EXPENSE (every expense must be in a
   * bucket per SPEC §6.1).
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

    let categoryId = input.categoryId ?? null;
    if (type === "EXPENSE") {
      if (categoryId === null) {
        return fail("INVALID_INPUT", "expense transactions require a category");
      }
      const category = await this.categoryRepo.loadCategoryContext(categoryId);
      if (category === null) {
        return fail("CATEGORY_NOT_FOUND", `category ${categoryId} not found`);
      }
      if (category.active === 0) {
        return fail("CATEGORY_INACTIVE", `category ${categoryId} is inactive`);
      }
    } else if (categoryId !== null) {
      const category = await this.categoryRepo.loadCategoryContext(categoryId);
      if (category === null) {
        return fail("CATEGORY_NOT_FOUND", `category ${categoryId} not found`);
      }
      if (category.active === 0) {
        return fail("CATEGORY_INACTIVE", `category ${categoryId} is inactive`);
      }
    }

    const entries = buildIncomeExpenseEntries(type, input, account.accountId, categoryId);

    let result;
    try {
      result = await this.txRepo.postTransaction({
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
    } catch (err) {
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to post transaction");
    }

    if (categoryId !== null) {
      // Favorites rise to the front: best-effort. We do not surface a
      // failure here because the transaction is already posted; the
      // favorite is presentation metadata, not ledger truth.
      await this.categoryRepo.recordCategoryUse(input.memberId, categoryId);
    }

    return ok({
      transaction: result.transaction,
      entries: result.entries,
      created: result.created,
    } as TransactionWithEntries);
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
    if (source.active === 0) {
      return fail("ACCOUNT_INACTIVE", `source account ${input.sourceAccountId} is inactive`);
    }
    if (source.archived === 1) {
      return fail("ACCOUNT_INACTIVE", `source account ${input.sourceAccountId} is archived`);
    }
    if (source.currencyCode !== input.currencyCode) {
      return fail(
        "CURRENCY_MISMATCH",
        `source account currency ${source.currencyCode} does not match transaction currency ${input.currencyCode}`
      );
    }

    const destination = await this.accountRepo.loadAccountContext(input.destinationAccountId);
    if (destination === null) {
      return fail("ACCOUNT_NOT_FOUND", `destination account ${input.destinationAccountId} not found`);
    }
    if (destination.active === 0) {
      return fail("ACCOUNT_INACTIVE", `destination account ${input.destinationAccountId} is inactive`);
    }
    if (destination.archived === 1) {
      return fail("ACCOUNT_INACTIVE", `destination account ${input.destinationAccountId} is archived`);
    }
    if (destination.currencyCode !== input.currencyCode) {
      return fail(
        "CURRENCY_MISMATCH",
        `destination account currency ${destination.currencyCode} does not match transaction currency ${input.currencyCode}`
      );
    }

    if (source.currencyCode !== destination.currencyCode) {
      return fail(
        "CROSS_CURRENCY_REJECTED",
        `cross-currency transfers are not supported (${source.currencyCode} -> ${destination.currencyCode})`
      );
    }

    const entries = buildTransferEntries(input, source.accountId, destination.accountId);

    let result;
    try {
      result = await this.txRepo.postTransaction({
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
    } catch (err) {
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to post transfer");
    }

    return ok({
      transaction: result.transaction,
      entries: result.entries,
      created: result.created,
    } as TransactionWithEntries);
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
      // process already reversed it.
      if (
        err instanceof Error &&
        /UNIQUE constraint failed: transactions\.idempotency_key/i.test(err.message)
      ) {
        return fail(
          "DUPLICATE_IDEMPOTENCY_KEY",
          `reversal key already exists for transaction ${input.transactionId}`
        );
      }
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to post reversal");
    }

    // Link the reversal, then mark the original REVERSED. We use the
    // repository's race-safe state transition: if markReversed returns
    // null, the original was already reversed by a concurrent caller.
    try {
      await this.txRepo.insertReversal(
        original.transaction.id,
        posted.transaction.id,
        input.reversedByMemberId,
        input.reason ?? null
      );
    } catch (err) {
      // If a UNIQUE collision on reversal_transaction_id, this reversal
      // transaction was already linked — that's fine; the post succeeded.
      if (
        err instanceof Error &&
        /UNIQUE constraint failed: transaction_reversals\.(original|reversal)_transaction_id/i.test(
          err.message
        )
      ) {
        // Fall through.
      } else {
        return fail("INTERNAL", err instanceof Error ? err.message : "Unable to record reversal linkage");
      }
    }

    const marked = await this.txRepo.markReversed(original.transaction.id);
    if (marked === null) {
      return fail("TRANSACTION_ALREADY_REVERSED", `transaction ${input.transactionId} is already reversed`);
    }

    return ok({
      transaction: posted.transaction,
      entries: posted.entries,
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
    // Member existence/active-state is verified at the repository boundary
    // by the accounts module's loadMemberContext (also accessible via the
    // account repository port). We do not load it here to keep this
    // service independent of the member table shape; the caller is
    // expected to have already resolved the actor. A future slice that
    // adds a MemberReadRepository will tighten this.
    return ok(true);
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
  categoryId: number | null
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
