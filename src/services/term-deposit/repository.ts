/**
 * Term-deposit repository interface.
 *
 * Application service depends on this abstract port. The D1 adapter in
 * `./d1-repository.ts` provides the production implementation; tests use
 * the same port against the FakeD1Database binding.
 *
 * The repository is responsible for:
 *   - row-to-domain mapping (no JS floating point on money/rates);
 *   - parameterized SQL only;
 *   - non-closure state-transition persistence with optimistic locking;
 *   - predecessor/successor link storage;
 *   - reading optional bank-quoted facts verbatim.
 *
 * The repository does NOT:
 *   - validate business invariants (those live in the application service);
 *   - compute interest estimates (M1A calculator does that);
 *   - emit closure transitions (those require evidence/ledger gates
 *     not in M1B scope).
 */

import type { TermDepositState } from "../../domain/term-deposit/index.js";
import type { BankQuotedPatch, CreateDraftInput, EditableFactsPatch, TermDepositRecord } from "./types.js";

/** Linked parent rows fetched once per operation to drive invariants. */
export interface AccountContext {
  readonly accountId: number;
  readonly accountType: string;
  readonly memberId: number;
  readonly bankId: number | null;
  readonly currencyCode: string;
  readonly active: number;
  readonly archived: number;
}

export interface MemberContext {
  readonly memberId: number;
  readonly active: number;
}

export interface BankContext {
  readonly bankId: number;
  readonly active: number;
}

export interface CurrencyContext {
  readonly code: string;
  readonly active: number;
}

export interface TermDepositRepository {
  /**
   * Insert a DRAFT term-deposit row using the supplied columns. The caller
   * must have already validated linkage; the repository performs no business
   * validation beyond the SQL CHECK constraints.
   */
  insertDraft(input: CreateDraftInput): Promise<TermDepositRecord>;

  /** SELECT by id. Returns null if no row matches. */
  findById(id: number): Promise<TermDepositRecord | null>;

  /**
   * SELECT all rows for a household member, ordered by maturity_date ASC
   * then id ASC. id is the stable tiebreaker for same-day deposits.
   */
  listByHolder(memberId: number): Promise<TermDepositRecord[]>;

  /**
   * SELECT every deposit currently in ACTIVE state, ordered by maturity_date
   * ASC then id ASC. Used by the reminder scanner to iterate all eligible
   * deposits without joining against household_members.
   */
  listAllActiveDeposits(): Promise<TermDepositRecord[]>;

  /**
   * SELECT every deposit currently in MATURED_ACTION_REQUIRED state,
   * ordered by maturity_date ASC then id ASC. Used by the action-required
   * query per SPEC §5.
   */
  listMaturedUnresolvedDeposits(): Promise<TermDepositRecord[]>;

  /**
   * Update editable draft/review facts. The repository enforces that the
   * row's current state is in `allowedStates` via optimistic locking; if
   * not, the operation throws.
   */
  updateEditableFacts(
    id: number,
    patch: EditableFactsPatch,
    allowedStates: readonly TermDepositState[]
  ): Promise<TermDepositRecord>;

  /**
   * Update optional bank-quoted contractual facts. Same optimistic locking
   * semantics as `updateEditableFacts`. Bank-quoted values do NOT alter
   * the deterministic system estimate.
   */
  updateBankQuotedFacts(
    id: number,
    patch: BankQuotedPatch,
    allowedStates: readonly TermDepositState[]
  ): Promise<TermDepositRecord>;

  /**
   * Update the maturity instruction + optional settlement account.
   */
  updateMaturityInstruction(
    id: number,
    instruction: import("../../domain/term-deposit/index.js").MaturityInstruction,
    settlementAccountId: number | null,
    allowedStates: readonly TermDepositState[]
  ): Promise<TermDepositRecord>;

  /**
   * Atomically transition a deposit's state. The repository writes
   * `UPDATE term_deposits SET state=? WHERE id=? AND state=?`; if 0 rows
   * are affected, the caller must treat it as a STALE_STATE failure.
   *
   * M1B exposes only the four non-closure transitions:
   *   DRAFT -> REVIEW_REQUIRED
   *   REVIEW_REQUIRED -> ACTIVE
   *   ACTIVE -> MATURED_ACTION_REQUIRED
   *   DRAFT -> CANCELLED
   */
  transitionState(
    id: number,
    expectedFrom: TermDepositState,
    to: TermDepositState
  ): Promise<{ affected: number; record: TermDepositRecord | null }>;

  /** Read the linked predecessor, if any. */
  loadPredecessor(id: number): Promise<TermDepositRecord | null>;

  /** Read the linked successor, if any. */
  loadSuccessor(id: number): Promise<TermDepositRecord | null>;

  // ── Linked parent context (used by application service for invariants) ────

  loadAccountContext(accountId: number): Promise<AccountContext | null>;
  loadMemberContext(memberId: number): Promise<MemberContext | null>;
  loadBankContext(bankId: number): Promise<BankContext | null>;
  loadCurrencyContext(code: string): Promise<CurrencyContext | null>;

  /**
   * Load an existing term-deposit context for invariants (e.g. predecessor
   * existence checks).
   */
  loadDepositContext(id: number): Promise<{ id: number } | null>;
}
