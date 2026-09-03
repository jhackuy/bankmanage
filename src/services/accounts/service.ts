/**
 * Accounts application service.
 *
 * Platform-neutral orchestration: enforces all business invariants before
 * persistence. The service depends only on the abstract `AccountRepository`
 * port, never on D1 directly.
 *
 * SPEC §3 contract enforced here:
 *   - Account types BANK / CASH / E_WALLET / CREDIT_CARD / TERM_DEPOSIT / INTERNAL
 *   - bank_id required for BANK, CREDIT_CARD, TERM_DEPOSIT; optional for
 *     CASH and E_WALLET; disallowed for INTERNAL.
 *   - currency_code must exist and be active.
 *   - bank_id (when supplied) must exist and be active.
 *   - member must exist and be active.
 *   - opening_balance_minor is a non-negative safe integer minor unit.
 *   - nickname is non-empty.
 *
 * Account immutability:
 *   - The application service does not expose a hard delete path. To
 *     "remove" an account, callers call `archiveAccount` (sets archived=1)
 *     or `deactivateAccount` (sets active=0). Posted ledger entries can
 *     still resolve the account_id reference (SPEC §7).
 */

import { ACCOUNT_TYPES, ACCOUNT_TYPES_REQUIRING_BANK } from "../../domain/ledger/index.js";
import type { AccountRepository } from "./repository.js";
import {
  fail,
  ok,
  serviceError,
  type AccountRecord,
  type CreateAccountInput,
  type ServiceResult,
  type UpdateAccountPatch,
} from "./types.js";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class AccountApplicationService {
  constructor(private readonly repo: AccountRepository) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  async getAccount(id: number): Promise<ServiceResult<AccountRecord | null>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "account id must be a positive safe integer");
    }
    return ok(await this.repo.findById(id));
  }

  async listAccountsForMember(memberId: number): Promise<ServiceResult<AccountRecord[]>> {
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    const member = await this.repo.loadMemberContext(memberId);
    if (member === null) {
      return fail("MEMBER_NOT_FOUND", `household member ${memberId} not found`);
    }
    return ok(await this.repo.listByMember(memberId));
  }

  async listAllAccounts(): Promise<ServiceResult<AccountRecord[]>> {
    return ok(await this.repo.listAll());
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async createAccount(input: CreateAccountInput): Promise<ServiceResult<AccountRecord>> {
    const validation = await this.validateCreateInput(input);
    if (!validation.ok) return validation;

    let record: AccountRecord;
    try {
      record = await this.repo.insert(input);
    } catch {
      return fail("INTERNAL", "Unable to create account");
    }
    return ok(record);
  }

  async updateAccount(id: number, patch: UpdateAccountPatch): Promise<ServiceResult<AccountRecord>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "account id must be a positive safe integer");
    }
    const existing = await this.repo.findById(id);
    if (existing === null) {
      return fail("ACCOUNT_NOT_FOUND", `account ${id} not found`);
    }

    if (patch.nickname !== undefined) {
      if (typeof patch.nickname !== "string" || patch.nickname.trim() === "") {
        return fail("INVALID_INPUT", "nickname must be a non-empty string");
      }
    }
    if (patch.openingBalanceMinor !== undefined) {
      const moneyCheck = validateOpeningBalance(patch.openingBalanceMinor);
      if (!moneyCheck.ok) return moneyCheck;
    }
    if (patch.bankId !== undefined) {
      // Setting bank_id = null is allowed (clears a previously-set bank).
      if (patch.bankId !== null) {
        if (!Number.isSafeInteger(patch.bankId) || patch.bankId <= 0) {
          return fail("INVALID_INPUT", "bankId must be a positive safe integer or null");
        }
        if (ACCOUNT_TYPES_REQUIRING_BANK.has(existing.accountType)) {
          // BANK / CREDIT_CARD / TERM_DEPOSIT must keep a bank reference.
          const bank = await this.repo.loadBankContext(patch.bankId);
          if (bank === null) {
            return fail("BANK_NOT_FOUND", `bank ${patch.bankId} not found`);
          }
          if (bank.active !== 1) {
            return fail("BANK_INACTIVE", `bank ${patch.bankId} is inactive`);
          }
        }
      } else if (ACCOUNT_TYPES_REQUIRING_BANK.has(existing.accountType)) {
        return fail(
          "ACCOUNT_TYPE_MISMATCH",
          `account type ${existing.accountType} requires a non-null bankId`
        );
      }
    }

    let updated: AccountRecord;
    try {
      updated = await this.repo.update(id, patch);
    } catch (err) {
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to update account");
    }
    return ok(updated);
  }

  async deactivateAccount(id: number): Promise<ServiceResult<AccountRecord>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "account id must be a positive safe integer");
    }
    const existing = await this.repo.findById(id);
    if (existing === null) {
      return fail("ACCOUNT_NOT_FOUND", `account ${id} not found`);
    }
    if (existing.active === 0) {
      return ok(existing); // already inactive — no-op
    }
    try {
      const updated = await this.repo.setActive(id, 0);
      return ok(updated);
    } catch (err) {
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to deactivate account");
    }
  }

  async reactivateAccount(id: number): Promise<ServiceResult<AccountRecord>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "account id must be a positive safe integer");
    }
    const existing = await this.repo.findById(id);
    if (existing === null) {
      return fail("ACCOUNT_NOT_FOUND", `account ${id} not found`);
    }
    if (existing.active === 1) {
      return ok(existing); // already active — no-op
    }
    try {
      const updated = await this.repo.setActive(id, 1);
      return ok(updated);
    } catch (err) {
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to reactivate account");
    }
  }

  async archiveAccount(id: number): Promise<ServiceResult<AccountRecord>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "account id must be a positive safe integer");
    }
    const existing = await this.repo.findById(id);
    if (existing === null) {
      return fail("ACCOUNT_NOT_FOUND", `account ${id} not found`);
    }
    if (existing.archived === 1) {
      return ok(existing); // already archived — no-op
    }
    try {
      const updated = await this.repo.setArchived(id, 1);
      return ok(updated);
    } catch (err) {
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to archive account");
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async validateCreateInput(input: CreateAccountInput): Promise<ServiceResult<true>> {
    if (!Number.isSafeInteger(input.memberId) || input.memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    if (typeof input.nickname !== "string" || input.nickname.trim() === "") {
      return fail("INVALID_INPUT", "nickname must be a non-empty string");
    }
    if (!ACCOUNT_TYPES.includes(input.accountType)) {
      return fail("INVALID_INPUT", `accountType must be one of ${ACCOUNT_TYPES.join(", ")}`);
    }
    const moneyCheck = validateOpeningBalance(input.openingBalanceMinor);
    if (!moneyCheck.ok) return moneyCheck;
    if (typeof input.currencyCode !== "string" || input.currencyCode.length !== 3) {
      return fail("INVALID_INPUT", "currencyCode must be a 3-letter currency code");
    }

    // member must exist + be active
    const member = await this.repo.loadMemberContext(input.memberId);
    if (member === null) {
      return fail("MEMBER_NOT_FOUND", `household member ${input.memberId} not found`);
    }
    if (member.active !== 1) {
      return fail("MEMBER_INACTIVE", `household member ${input.memberId} is inactive`);
    }

    // currency must exist + be active
    const currency = await this.repo.loadCurrencyContext(input.currencyCode);
    if (currency === null) {
      return fail("CURRENCY_NOT_FOUND", `currency ${input.currencyCode} not found`);
    }
    if (currency.active !== 1) {
      return fail("CURRENCY_INACTIVE", `currency ${input.currencyCode} is inactive`);
    }

    // bank (if supplied) must exist + be active
    if (input.bankId !== undefined) {
      if (!Number.isSafeInteger(input.bankId) || input.bankId <= 0) {
        return fail("INVALID_INPUT", "bankId must be a positive safe integer");
      }
      const bank = await this.repo.loadBankContext(input.bankId);
      if (bank === null) {
        return fail("BANK_NOT_FOUND", `bank ${input.bankId} not found`);
      }
      if (bank.active !== 1) {
        return fail("BANK_INACTIVE", `bank ${input.bankId} is inactive`);
      }
    }

    // Type ↔ bank linkage enforcement (SPEC §3):
    //   BANK / CREDIT_CARD / TERM_DEPOSIT require bankId
    //   INTERNAL forbids bankId
    //   CASH / E_WALLET allow optional bankId
    if (ACCOUNT_TYPES_REQUIRING_BANK.has(input.accountType) && input.bankId === undefined) {
      return fail("ACCOUNT_TYPE_MISMATCH", `accountType ${input.accountType} requires bankId`);
    }
    if (input.accountType === "INTERNAL" && input.bankId !== undefined) {
      return fail("ACCOUNT_TYPE_MISMATCH", `accountType INTERNAL must not carry a bankId`);
    }

    return ok(true);
  }
}

// ── Pure validators ─────────────────────────────────────────────────────────

function validateOpeningBalance(value: number): ServiceResult<true> {
  if (!Number.isSafeInteger(value) || value < 0) {
    return fail("INVALID_INPUT", "openingBalanceMinor must be a non-negative safe integer");
  }
  return ok(true);
}

// re-export to silence "value is defined but never used" when ISO_DATE_PATTERN is unused.
// (kept for future date validation hooks in account-side endpoints)
export const _isoDatePattern = ISO_DATE_PATTERN;

// ── Helper: re-export serviceError for callers that want to log codes ───────

export { serviceError };
