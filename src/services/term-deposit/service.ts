/**
 * Term-deposit application service.
 *
 * Platform-neutral orchestration: enforces all business invariants before
 * persistence, computes the deterministic interest estimate via the M1A
 * calculator, and dispatches lifecycle operations through the M1A state
 * machine. The service depends only on the abstract `TermDepositRepository`
 * port, never on D1 directly.
 *
 * M1B exposes only the four non-closure lifecycle operations:
 *   - DRAFT -> REVIEW_REQUIRED
 *   - REVIEW_REQUIRED -> ACTIVE
 *   - ACTIVE -> MATURED_ACTION_REQUIRED
 *   - DRAFT -> CANCELLED
 *
 * Closure transitions (SETTLED_TO_ACCOUNT, RENEWED, PRETERMINATED) require
 * evidence + balanced-ledger gates that are not yet implemented and are
 * explicitly out of scope for M1B.
 *
 * All multi-write operations are atomic through the repository's optimistic
 * state-locking UPDATEs. A failure surfaces as a typed ServiceResult without
 * partial mutation.
 */

import {
  calculateEstimate,
  DAY_COUNT_BASES,
  MATURITY_INSTRUCTIONS,
  MAX_ANNUAL_RATE_SCALED,
  MAX_TAX_RATE_SCALED,
  transition as validateTransition,
  type ClosureGateInput,
  type InterestEstimate,
  type InterestMethod,
  type MaturityInstruction,
  type TermDepositState,
} from "../../domain/term-deposit/index.js";
import type { TermDepositRepository } from "./repository.js";
import {
  fail,
  ok,
  serviceError,
  type BankQuotedPatch,
  type CreateDraftInput,
  type EditableFactsPatch,
  type ServiceErrorCode,
  type ServiceResult,
  type TermDepositRecord,
  type TermDepositWithEstimate,
} from "./types.js";

// States in which editable facts may be patched. These match SPEC §4.2 —
// once a deposit is ACTIVE the financial terms are locked in by the bank.
const EDITABLE_STATES: readonly TermDepositState[] = ["DRAFT", "REVIEW_REQUIRED"];

// States in which optional bank-quoted facts may be updated — extendable
// through ACTIVE so OWNER can cross-check while the deposit runs.
const BANK_QUOTED_STATES: readonly TermDepositState[] = ["DRAFT", "REVIEW_REQUIRED", "ACTIVE"];

// Allowed lifecycle transitions in M1B.
const ALLOWED_TRANSITIONS: ReadonlyMap<TermDepositState, readonly TermDepositState[]> = new Map([
  ["DRAFT", ["REVIEW_REQUIRED", "CANCELLED"]],
  ["REVIEW_REQUIRED", ["ACTIVE"]],
  ["ACTIVE", ["MATURED_ACTION_REQUIRED"]],
]);

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CERTIFICATE_PATTERN = /^\d{4}$/;

export class TermDepositApplicationService {
  constructor(private readonly repo: TermDepositRepository) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async getDeposit(id: number): Promise<ServiceResult<TermDepositWithEstimate | null>> {
    const record = await this.repo.findById(id);
    if (record === null) return ok(null);
    const estimate = this.computeEstimate(record);
    return ok({ record, estimate });
  }

  async listDeposits(holderMemberId: number): Promise<ServiceResult<TermDepositWithEstimate[]>> {
    const memberCtx = await this.repo.loadMemberContext(holderMemberId);
    if (memberCtx === null) {
      return fail("MEMBER_NOT_FOUND", `household member ${holderMemberId} does not exist`);
    }
    const records = await this.repo.listByHolder(holderMemberId);
    const enriched: TermDepositWithEstimate[] = records.map((record) => ({
      record,
      estimate: this.computeEstimate(record),
    }));
    return ok(enriched);
  }

  async getPredecessor(id: number): Promise<ServiceResult<TermDepositRecord | null>> {
    const self = await this.repo.findById(id);
    if (self === null) return fail("DEPOSIT_NOT_FOUND", `term deposit ${id} not found`);
    return ok(await this.repo.loadPredecessor(id));
  }

  async getSuccessor(id: number): Promise<ServiceResult<TermDepositRecord | null>> {
    const self = await this.repo.findById(id);
    if (self === null) return fail("DEPOSIT_NOT_FOUND", `term deposit ${id} not found`);
    return ok(await this.repo.loadSuccessor(id));
  }

  // ── Writes: draft creation ───────────────────────────────────────────────

  async createDraft(input: CreateDraftInput): Promise<ServiceResult<TermDepositWithEstimate>> {
    const validation = await this.validateCreateInput(input);
    if (!validation.ok) return validation;

    // Compute the deterministic estimate from the validated input BEFORE
    // INSERT. The inputs already passed validateCreateInput, so the only
    // remaining throw from calculateEstimate is a safe-integer overflow on
    // the computed maturity amount. Catching here keeps the zero-partial-
    // mutation invariant: no row is persisted when the estimate overflows.
    let estimate: InterestEstimate;
    try {
      estimate = calculateEstimate({
        principalMinor: input.principalMinor,
        annualRateScaled: input.annualRateScaled,
        taxRateScaled: input.taxRateScaled,
        feesMinor: input.feesMinor,
        startDate: input.startDate,
        maturityDate: input.maturityDate,
        interestMethod: input.interestMethod,
        dayCountBasis: input.dayCountBasis,
      });
    } catch {
      return fail("INVALID_INPUT", "interest estimate exceeds safe-integer range; reduce principal or rate");
    }

    let record: TermDepositRecord;
    try {
      record = await this.repo.insertDraft(input);
    } catch (err) {
      // Race-safe boundary: the UNIQUE index on predecessor_deposit_id
      // catches concurrent inserts that both reference the same predecessor.
      // The service-level pre-check above handles the common case; this
      // branch covers the race where a sibling request slipped between the
      // pre-check and the INSERT. Only the specific UNIQUE violation on the
      // predecessor_deposit_id column maps to DUPLICATE_LINK — other FK,
      // CHECK, or UNIQUE-on-different-column violations retain the generic
      // typed failure path.
      if (
        input.predecessorDepositId !== undefined &&
        err instanceof Error &&
        /UNIQUE constraint failed: term_deposits\.predecessor_deposit_id/i.test(err.message)
      ) {
        return fail(
          "DUPLICATE_LINK",
          `predecessor deposit ${input.predecessorDepositId} already has a successor`
        );
      }
      return fail("INTERNAL", "Unable to create term deposit");
    }
    return ok({ record, estimate });
  }

  // ── Writes: editable draft/review facts ──────────────────────────────────

  async updateEditableFacts(
    id: number,
    patch: EditableFactsPatch
  ): Promise<ServiceResult<TermDepositWithEstimate>> {
    const existing = await this.repo.findById(id);
    if (existing === null) {
      return fail("DEPOSIT_NOT_FOUND", `term deposit ${id} not found`);
    }
    if (!EDITABLE_STATES.includes(existing.state)) {
      return fail(
        "ILLEGAL_TRANSITION",
        `editable facts can only be patched in DRAFT or REVIEW_REQUIRED; current state is ${existing.state}`
      );
    }
    if (
      patch.productName !== undefined &&
      (typeof patch.productName !== "string" || patch.productName.trim() === "")
    ) {
      return fail("INVALID_INPUT", "productName must be a non-empty string");
    }
    if (patch.nickname !== undefined && patch.nickname !== null && typeof patch.nickname !== "string") {
      return fail("INVALID_INPUT", "nickname must be a string or null");
    }
    if (patch.certificateLastFour !== undefined) {
      const certCheck = validateCertificate(patch.certificateLastFour);
      if (!certCheck.ok) return certCheck;
    }
    if (patch.dayCountBasis !== undefined && !DAY_COUNT_BASES.includes(patch.dayCountBasis)) {
      return fail("INVALID_INPUT", "dayCountBasis is invalid");
    }
    if (patch.maturityInstruction !== undefined) {
      const instructionCheck = validateMaturityInstruction(patch.maturityInstruction);
      if (!instructionCheck.ok) return instructionCheck;
    }
    if (
      patch.maturitySettlementAccountId !== undefined &&
      patch.maturitySettlementAccountId !== null &&
      (!Number.isSafeInteger(patch.maturitySettlementAccountId) || patch.maturitySettlementAccountId <= 0)
    ) {
      return fail("INVALID_INPUT", "maturitySettlementAccountId must be a positive safe integer or null");
    }
    if (
      patch.sourceEvidenceRef !== undefined &&
      patch.sourceEvidenceRef !== null &&
      typeof patch.sourceEvidenceRef !== "string"
    ) {
      return fail("INVALID_INPUT", "sourceEvidenceRef must be a string or null");
    }
    if (patch.interestMethod !== undefined) {
      const methodCheck = validateInterestMethod(patch.interestMethod);
      if (!methodCheck.ok) return methodCheck;
    }
    if (
      patch.principalMinor !== undefined ||
      patch.annualRateScaled !== undefined ||
      patch.taxRateScaled !== undefined ||
      patch.feesMinor !== undefined
    ) {
      const moneyCheck = validateMoney(
        patch.principalMinor ?? existing.principalMinor,
        patch.annualRateScaled ?? existing.annualRateScaled,
        patch.taxRateScaled ?? existing.taxRateScaled,
        patch.feesMinor ?? existing.feesMinor
      );
      if (!moneyCheck.ok) return moneyCheck;
    }
    if (patch.startDate !== undefined || patch.maturityDate !== undefined) {
      const datesCheck = validateDates(
        patch.startDate ?? existing.startDate,
        patch.maturityDate ?? existing.maturityDate
      );
      if (!datesCheck.ok) return datesCheck;
    }

    // If the patch touches estimate-affecting fields, compute the estimate
    // from the merged values BEFORE UPDATE so a safe-integer overflow cannot
    // produce partial mutation. validateMoney above already rejected inputs
    // outside safe-integer ranges, so the only remaining throw is overflow.
    const affectsEstimate =
      patch.principalMinor !== undefined ||
      patch.annualRateScaled !== undefined ||
      patch.taxRateScaled !== undefined ||
      patch.feesMinor !== undefined ||
      patch.startDate !== undefined ||
      patch.maturityDate !== undefined ||
      patch.interestMethod !== undefined ||
      patch.dayCountBasis !== undefined;

    if (affectsEstimate) {
      try {
        calculateEstimate({
          principalMinor: patch.principalMinor ?? existing.principalMinor,
          annualRateScaled: patch.annualRateScaled ?? existing.annualRateScaled,
          taxRateScaled: patch.taxRateScaled ?? existing.taxRateScaled,
          feesMinor: patch.feesMinor ?? existing.feesMinor,
          startDate: patch.startDate ?? existing.startDate,
          maturityDate: patch.maturityDate ?? existing.maturityDate,
          interestMethod: patch.interestMethod ?? existing.interestMethod,
          dayCountBasis: patch.dayCountBasis ?? existing.dayCountBasis,
        });
      } catch {
        return fail(
          "INVALID_INPUT",
          "interest estimate exceeds safe-integer range; reduce principal or rate"
        );
      }
    }

    let updated: TermDepositRecord;
    try {
      updated = await this.repo.updateEditableFacts(id, patch, EDITABLE_STATES);
    } catch (err) {
      // Race: state moved out of EDITABLE_STATES between our SELECT and UPDATE.
      return fail(
        "STALE_STATE",
        err instanceof Error ? err.message : "stale state during editable-facts update"
      );
    }
    return ok({ record: updated, estimate: this.computeEstimate(updated) });
  }

  // ── Writes: bank-quoted facts ────────────────────────────────────────────

  async updateBankQuotedFacts(
    id: number,
    patch: BankQuotedPatch
  ): Promise<ServiceResult<TermDepositWithEstimate>> {
    const existing = await this.repo.findById(id);
    if (existing === null) {
      return fail("DEPOSIT_NOT_FOUND", `term deposit ${id} not found`);
    }
    if (!BANK_QUOTED_STATES.includes(existing.state)) {
      return fail("ILLEGAL_TRANSITION", `bank-quoted facts cannot be changed in state ${existing.state}`);
    }
    if (
      patch.bankQuotedGrossInterestMinor !== undefined &&
      patch.bankQuotedGrossInterestMinor !== null &&
      (!Number.isSafeInteger(patch.bankQuotedGrossInterestMinor) || patch.bankQuotedGrossInterestMinor < 0)
    ) {
      return fail(
        "INVALID_INPUT",
        "bankQuotedGrossInterestMinor must be a non-negative safe integer or null"
      );
    }
    if (
      patch.bankQuotedNetInterestMinor !== undefined &&
      patch.bankQuotedNetInterestMinor !== null &&
      (!Number.isSafeInteger(patch.bankQuotedNetInterestMinor) || patch.bankQuotedNetInterestMinor < 0)
    ) {
      return fail("INVALID_INPUT", "bankQuotedNetInterestMinor must be a non-negative safe integer or null");
    }
    if (
      patch.bankQuotedMaturityAmountMinor !== undefined &&
      patch.bankQuotedMaturityAmountMinor !== null &&
      (!Number.isSafeInteger(patch.bankQuotedMaturityAmountMinor) || patch.bankQuotedMaturityAmountMinor < 0)
    ) {
      return fail(
        "INVALID_INPUT",
        "bankQuotedMaturityAmountMinor must be a non-negative safe integer or null"
      );
    }

    let updated: TermDepositRecord;
    try {
      updated = await this.repo.updateBankQuotedFacts(id, patch, BANK_QUOTED_STATES);
    } catch (err) {
      return fail(
        "STALE_STATE",
        err instanceof Error ? err.message : "stale state during bank-quoted update"
      );
    }
    return ok({ record: updated, estimate: this.computeEstimate(updated) });
  }

  // ── Writes: lifecycle transitions ────────────────────────────────────────

  async submitForReview(id: number): Promise<ServiceResult<TermDepositRecord>> {
    return this.runTransition(id, "REVIEW_REQUIRED");
  }

  async activate(id: number): Promise<ServiceResult<TermDepositRecord>> {
    return this.runTransition(id, "ACTIVE");
  }

  async markMatured(id: number): Promise<ServiceResult<TermDepositRecord>> {
    return this.runTransition(id, "MATURED_ACTION_REQUIRED");
  }

  async cancelDraft(id: number): Promise<ServiceResult<TermDepositRecord>> {
    return this.runTransition(id, "CANCELLED");
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async runTransition(
    id: number,
    target: TermDepositState
  ): Promise<ServiceResult<TermDepositRecord>> {
    const existing = await this.repo.findById(id);
    if (existing === null) {
      return fail("DEPOSIT_NOT_FOUND", `term deposit ${id} not found`);
    }
    const allowedTargets = ALLOWED_TRANSITIONS.get(existing.state);
    if (allowedTargets === undefined) {
      // No M1B transitions defined from this state (terminal states, or
      // states whose only forward edges require closure gates we do not
      // expose yet — e.g. MATURED_ACTION_REQUIRED -> SETTLED_TO_ACCOUNT).
      return fail("ILLEGAL_TRANSITION", `no M1B transitions from ${existing.state}`);
    }
    if (!allowedTargets.includes(target)) {
      return fail(
        "ILLEGAL_TRANSITION",
        `illegal transition ${existing.state} -> ${target} (not allowed in M1B)`
      );
    }
    // For CANCELLED the state machine expects a gate (or none); M1B does not
    // require evidence, so a CANCEL gate (or no gate) is acceptable.
    const gateCheck =
      target === "CANCELLED"
        ? validateTransition({
            from: existing.state,
            to: target,
            gate: { kind: "CANCEL" } satisfies ClosureGateInput,
          })
        : validateTransition({ from: existing.state, to: target });
    if (!gateCheck.ok) {
      return fail("ILLEGAL_TRANSITION", gateCheck.reason);
    }

    const result = await this.repo.transitionState(id, existing.state, target);
    if (result.affected === 0 || result.record === null) {
      return fail(
        "STALE_STATE",
        `transition ${existing.state} -> ${target} lost optimistic lock; refresh and retry`
      );
    }
    return ok(result.record);
  }

  private computeEstimate(record: TermDepositRecord): InterestEstimate {
    return calculateEstimate({
      principalMinor: record.principalMinor,
      annualRateScaled: record.annualRateScaled,
      taxRateScaled: record.taxRateScaled,
      feesMinor: record.feesMinor,
      startDate: record.startDate,
      maturityDate: record.maturityDate,
      interestMethod: record.interestMethod,
      dayCountBasis: record.dayCountBasis,
    });
  }

  private async validateCreateInput(input: CreateDraftInput): Promise<ServiceResult<true>> {
    for (const [name, value] of [
      ["accountId", input.accountId],
      ["bankId", input.bankId],
      ["holderMemberId", input.holderMemberId],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        return fail("INVALID_INPUT", `${name} must be a positive safe integer`);
      }
    }

    // Certificate privacy boundary: exactly four ASCII digits. Longer or
    // shorter values must be rejected here, never trimmed/stored partially.
    const certCheck = validateCertificate(input.certificateLastFour);
    if (!certCheck.ok) return certCheck;

    // COMPOUND is an explicit blocker until a compounding-frequency contract
    // exists. The M1A calculator already throws, but we surface a typed error
    // before persistence to keep error handling uniform.
    const methodCheck = validateInterestMethod(input.interestMethod);
    if (!methodCheck.ok) return methodCheck;

    // Day-count basis must come from the domain source-of-truth list. The
    // calculator only accepts these values too, but validating at the
    // untrusted runtime boundary gives callers a typed INVALID_INPUT before
    // persistence instead of a calculator throw after it.
    if (!DAY_COUNT_BASES.includes(input.dayCountBasis)) {
      return fail("INVALID_INPUT", "dayCountBasis is invalid");
    }

    // Strict money/rate/date validation through the same checks the
    // calculator performs. We re-run them so the application service can
    // reject with a typed result before INSERT (the calculator throws).
    const moneyCheck = validateMoney(
      input.principalMinor,
      input.annualRateScaled,
      input.taxRateScaled,
      input.feesMinor
    );
    if (!moneyCheck.ok) return moneyCheck;

    const quotedCheck = validateBankQuotedValues(
      input.bankQuotedGrossInterestMinor,
      input.bankQuotedNetInterestMinor,
      input.bankQuotedMaturityAmountMinor
    );
    if (!quotedCheck.ok) return quotedCheck;

    const datesCheck = validateDates(input.startDate, input.maturityDate);
    if (!datesCheck.ok) return datesCheck;

    if (typeof input.currencyCode !== "string" || input.currencyCode.trim() === "") {
      return fail("INVALID_INPUT", "currencyCode must be a non-empty string");
    }
    if (typeof input.productName !== "string" || input.productName.trim() === "") {
      return fail("INVALID_INPUT", "productName must be a non-empty string");
    }
    if (input.nickname !== undefined && typeof input.nickname !== "string") {
      return fail("INVALID_INPUT", "nickname must be a string when provided");
    }

    if (
      input.maturitySettlementAccountId !== undefined &&
      (!Number.isSafeInteger(input.maturitySettlementAccountId) || input.maturitySettlementAccountId <= 0)
    ) {
      return fail("INVALID_INPUT", "maturitySettlementAccountId must be a positive safe integer");
    }
    if (
      input.predecessorDepositId !== undefined &&
      (!Number.isSafeInteger(input.predecessorDepositId) || input.predecessorDepositId <= 0)
    ) {
      return fail("INVALID_INPUT", "predecessorDepositId must be a positive safe integer");
    }
    if (input.maturityInstruction !== undefined) {
      const instrCheck = validateMaturityInstruction(input.maturityInstruction);
      if (!instrCheck.ok) return instrCheck;
    }
    if (input.sourceEvidenceRef !== undefined && typeof input.sourceEvidenceRef !== "string") {
      return fail("INVALID_INPUT", "sourceEvidenceRef must be a string when provided");
    }

    // Linkage invariants: account must be TERM_DEPOSIT, owned by the holder
    // member, link to the supplied bank and currency. Member/bank/currency
    // must each exist and be active.
    //
    // Existence of bank/currency/member is checked first so callers see the
    // most specific error (BANK_NOT_FOUND, CURRENCY_NOT_FOUND, etc.) before
    // the relationship-mismatch errors below.
    const member = await this.repo.loadMemberContext(input.holderMemberId);
    if (member === null) {
      return fail("MEMBER_NOT_FOUND", `household member ${input.holderMemberId} not found`);
    }
    if (member.active !== 1) {
      return fail("MEMBER_NOT_FOUND", `household member ${input.holderMemberId} is inactive`);
    }

    const bank = await this.repo.loadBankContext(input.bankId);
    if (bank === null) {
      return fail("BANK_NOT_FOUND", `bank ${input.bankId} not found`);
    }
    if (bank.active !== 1) {
      return fail("BANK_NOT_FOUND", `bank ${input.bankId} is inactive`);
    }

    const currency = await this.repo.loadCurrencyContext(input.currencyCode);
    if (currency === null) {
      return fail("CURRENCY_NOT_FOUND", `currency ${input.currencyCode} not found`);
    }
    if (currency.active !== 1) {
      return fail("CURRENCY_NOT_FOUND", `currency ${input.currencyCode} is inactive`);
    }

    const account = await this.repo.loadAccountContext(input.accountId);
    if (account === null) {
      return fail("NOT_FOUND", `account ${input.accountId} not found`);
    }
    if (account.active !== 1 || account.archived === 1) {
      return fail("NOT_FOUND", `account ${input.accountId} is inactive or archived`);
    }
    if (account.accountType !== "TERM_DEPOSIT") {
      return fail(
        "ACCOUNT_TYPE_MISMATCH",
        `account ${input.accountId} is type ${account.accountType}; expected TERM_DEPOSIT`
      );
    }
    if (account.memberId !== input.holderMemberId) {
      return fail(
        "ACCOUNT_LINKAGE_MISMATCH",
        `account ${input.accountId} belongs to member ${account.memberId}; holder is ${input.holderMemberId}`
      );
    }
    if (account.bankId !== input.bankId) {
      return fail(
        "ACCOUNT_LINKAGE_MISMATCH",
        `account ${input.accountId} is bound to bank ${account.bankId ?? "null"}; submitted ${input.bankId}`
      );
    }
    if (account.currencyCode !== input.currencyCode) {
      return fail(
        "ACCOUNT_LINKAGE_MISMATCH",
        `account ${input.accountId} uses currency ${account.currencyCode}; submitted ${input.currencyCode}`
      );
    }

    if (input.predecessorDepositId !== undefined) {
      const pred = await this.repo.loadDepositContext(input.predecessorDepositId);
      if (pred === null) {
        return fail("PREDECESSOR_NOT_FOUND", `predecessor deposit ${input.predecessorDepositId} not found`);
      }
      // Enforce the 1:1 predecessor→successor invariant. The schema-level
      // UNIQUE index on predecessor_deposit_id is the race-safe boundary;
      // this pre-check avoids an unnecessary INSERT and gives a clearer
      // error for the common case.
      const existingSuccessor = await this.repo.loadSuccessor(input.predecessorDepositId);
      if (existingSuccessor !== null) {
        return fail(
          "DUPLICATE_LINK",
          `predecessor deposit ${input.predecessorDepositId} already has successor deposit ${existingSuccessor.id}`
        );
      }
      // Self-loop is prevented by the schema CHECK constraint
      // (predecessor_deposit_id IS NULL OR predecessor_deposit_id <> id).
      // We can't enforce it in the application layer because the new row's
      // id isn't known until INSERT.
    }

    return ok(true);
  }
}

// ── Pure validators ────────────────────────────────────────────────────────

function invalid(code: ServiceErrorCode, message: string): ServiceResult<true> {
  return fail(code, message);
}

function validateCertificate(cert: string): ServiceResult<true> {
  if (typeof cert !== "string" || !CERTIFICATE_PATTERN.test(cert)) {
    return invalid(
      "INVALID_INPUT",
      "certificateLastFour must be exactly four ASCII digits; longer/full certificate numbers must never reach the model"
    );
  }
  return ok(true);
}

function validateInterestMethod(method: InterestMethod): ServiceResult<true> {
  if (method !== "SIMPLE") {
    return invalid(
      "INVALID_INPUT",
      "interestMethod must be SIMPLE; COMPOUND requires an explicit compounding-frequency contract that does not yet exist"
    );
  }
  return ok(true);
}

function validateMaturityInstruction(instruction: MaturityInstruction): ServiceResult<true> {
  if (!MATURITY_INSTRUCTIONS.includes(instruction)) {
    return invalid("INVALID_INPUT", `maturityInstruction is invalid: ${String(instruction)}`);
  }
  return ok(true);
}

function validateBankQuotedValues(
  gross: number | undefined,
  net: number | undefined,
  maturity: number | undefined
): ServiceResult<true> {
  for (const [name, value] of [
    ["bankQuotedGrossInterestMinor", gross],
    ["bankQuotedNetInterestMinor", net],
    ["bankQuotedMaturityAmountMinor", maturity],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      return invalid("INVALID_INPUT", `${name} must be a non-negative safe integer`);
    }
  }
  return ok(true);
}

function validateMoney(
  principal: number,
  annualRateScaled: number,
  taxRateScaled: number,
  feesMinor: number
): ServiceResult<true> {
  if (!Number.isSafeInteger(principal) || principal < 0) {
    return invalid("INVALID_INPUT", `principalMinor must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(annualRateScaled) || annualRateScaled < 0) {
    return invalid("INVALID_INPUT", `annualRateScaled must be a non-negative safe integer`);
  }
  if (annualRateScaled > MAX_ANNUAL_RATE_SCALED) {
    return invalid("INVALID_INPUT", `annualRateScaled exceeds sanity ceiling (${MAX_ANNUAL_RATE_SCALED})`);
  }
  if (!Number.isSafeInteger(taxRateScaled) || taxRateScaled < 0) {
    return invalid("INVALID_INPUT", `taxRateScaled must be a non-negative safe integer`);
  }
  if (taxRateScaled > MAX_TAX_RATE_SCALED) {
    return invalid("INVALID_INPUT", `taxRateScaled exceeds 100% (${MAX_TAX_RATE_SCALED})`);
  }
  if (!Number.isSafeInteger(feesMinor) || feesMinor < 0) {
    return invalid("INVALID_INPUT", `feesMinor must be a non-negative safe integer`);
  }
  return ok(true);
}

function validateDates(startDate: string, maturityDate: string): ServiceResult<true> {
  if (!isIsoDate(startDate)) {
    return invalid("INVALID_INPUT", `startDate must be a strict ISO calendar date: ${startDate}`);
  }
  if (!isIsoDate(maturityDate)) {
    return invalid("INVALID_INPUT", `maturityDate must be a strict ISO calendar date: ${maturityDate}`);
  }
  if (maturityDate < startDate) {
    return invalid("INVALID_INPUT", `maturityDate ${maturityDate} must not be before startDate ${startDate}`);
  }
  return ok(true);
}

function isIsoDate(s: string): boolean {
  if (typeof s !== "string" || !ISO_DATE_PATTERN.test(s)) return false;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
  );
}

// ── Helper: re-export serviceError for callers that want to log codes ───────

export { serviceError };
