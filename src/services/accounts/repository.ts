/**
 * Accounts repository interface.
 *
 * Application service depends on this abstract port. The D1 adapter in
 * `./d1-repository.ts` provides the production implementation; tests use
 * the same port against the FakeD1Database binding.
 *
 * The repository is responsible for:
 *   - row-to-domain mapping (no JS floating point on money);
 *   - parameterized SQL only;
 *   - active/archived reads verbatim.
 *
 * The repository does NOT:
 *   - validate business invariants (those live in the application service);
 *   - compute account balances from the ledger (M2A leaves that for a
 *     dedicated read-side service slice).
 */

import type { AccountType } from "../../domain/ledger/index.js";
import type {
  AccountContext,
  AccountRecord,
  BankContext,
  CreateAccountInput,
  CurrencyContext,
  MemberContext,
  UpdateAccountPatch,
} from "./types.js";

export type { AccountContext, BankContext, CurrencyContext, MemberContext } from "./types.js";

export interface AccountRepository {
  /** Insert a new account row. Caller must have validated business rules. */
  insert(input: CreateAccountInput): Promise<AccountRecord>;

  /** SELECT by id. Returns null if no row matches. */
  findById(id: number): Promise<AccountRecord | null>;

  /** SELECT every account owned by a household member, ordered by id ASC. */
  listByMember(memberId: number): Promise<AccountRecord[]>;

  /** SELECT every account across all members. Caller decides filtering. */
  listAll(): Promise<AccountRecord[]>;

  /**
   * Patch mutable fields (nickname / opening_balance / bank_id). The
   * linked account_type, currency_code, and member_id are intentionally
   * NOT patchable. Throws if no row matches.
   */
  update(id: number, patch: UpdateAccountPatch): Promise<AccountRecord>;

  /**
   * Set active = 0. Reversible by setActive(id, 1). Use archiveAccount()
   * for a stronger signal that hides the account from default lists.
   */
  setActive(id: number, active: number): Promise<AccountRecord>;

  /**
   * Set archived = 1. Archived accounts remain in the table (no physical
   * deletion) so historical ledger entries can still resolve their
   * account reference (SPEC §7 immutability).
   */
  setArchived(id: number, archived: number): Promise<AccountRecord>;

  // ── Linked parent context (used by application service for invariants) ────

  loadAccountContext(accountId: number): Promise<AccountContext | null>;
  loadMemberContext(memberId: number): Promise<MemberContext | null>;
  loadBankContext(bankId: number): Promise<BankContext | null>;
  loadCurrencyContext(code: string): Promise<CurrencyContext | null>;

  /**
   * Cheap lookup used by the transaction service to enforce account-active
   * + currency-compatibility rules. Returns null if the id does not exist.
   */
  loadAccountType(accountId: number): Promise<AccountType | null>;
}
