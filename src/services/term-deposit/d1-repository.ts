/**
 * D1 implementation of the term-deposit repository.
 *
 * All SQL is parameterized. No raw D1 binding escapes this module — the
 * application service sees only the abstract `TermDepositRepository` port.
 *
 * Row mapping returns money/rate columns directly. The TypeScript row type
 * guarantees they are numbers; SQLite INTEGER storage keeps them lossless.
 * No arithmetic happens here.
 */

import type { D1Database } from "../../adapters/d1/types.js";
import type {
  DayCountBasis,
  InterestMethod,
  MaturityInstruction,
  TermDepositState,
} from "../../domain/term-deposit/index.js";
import type {
  AccountContext,
  BankContext,
  CurrencyContext,
  MemberContext,
  TermDepositRepository,
} from "./repository.js";
import type { BankQuotedPatch, CreateDraftInput, EditableFactsPatch, TermDepositRecord } from "./types.js";

// ── Row type as stored in SQLite ────────────────────────────────────────────

interface TermDepositRow {
  id: number;
  account_id: number;
  bank_id: number;
  holder_member_id: number;
  currency_code: string;
  product_name: string;
  nickname: string | null;
  certificate_last_four: string;
  principal_minor: number;
  start_date: string;
  maturity_date: string;
  annual_rate_scaled: number;
  tax_rate_scaled: number;
  fees_minor: number;
  interest_method: string;
  day_count_basis: string;
  state: string;
  bank_quoted_gross_interest_minor: number | null;
  bank_quoted_net_interest_minor: number | null;
  bank_quoted_maturity_amount_minor: number | null;
  maturity_instruction: string;
  maturity_settlement_account_id: number | null;
  predecessor_deposit_id: number | null;
  successor_deposit_id: number | null;
  source_evidence_ref: string | null;
  settlement_evidence_ref: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: TermDepositRow): TermDepositRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    bankId: row.bank_id,
    holderMemberId: row.holder_member_id,
    currencyCode: row.currency_code,
    productName: row.product_name,
    nickname: row.nickname,
    certificateLastFour: row.certificate_last_four,
    principalMinor: row.principal_minor,
    startDate: row.start_date,
    maturityDate: row.maturity_date,
    annualRateScaled: row.annual_rate_scaled,
    taxRateScaled: row.tax_rate_scaled,
    feesMinor: row.fees_minor,
    interestMethod: row.interest_method as InterestMethod,
    dayCountBasis: row.day_count_basis as DayCountBasis,
    state: row.state as TermDepositState,
    bankQuotedGrossInterestMinor: row.bank_quoted_gross_interest_minor,
    bankQuotedNetInterestMinor: row.bank_quoted_net_interest_minor,
    bankQuotedMaturityAmountMinor: row.bank_quoted_maturity_amount_minor,
    maturityInstruction: row.maturity_instruction as MaturityInstruction,
    maturitySettlementAccountId: row.maturity_settlement_account_id,
    predecessorDepositId: row.predecessor_deposit_id,
    successorDepositId: row.successor_deposit_id,
    sourceEvidenceRef: row.source_evidence_ref,
    settlementEvidenceRef: row.settlement_evidence_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── D1 Repository ───────────────────────────────────────────────────────────

const M1B_TRANSITION_EDGES = new Set([
  "DRAFT->REVIEW_REQUIRED",
  "REVIEW_REQUIRED->ACTIVE",
  "ACTIVE->MATURED_ACTION_REQUIRED",
  "DRAFT->CANCELLED",
]);

function assertAllowedStates(method: string, allowedStates: readonly TermDepositState[]): void {
  if (allowedStates.length === 0) {
    throw new Error(`${method}: allowedStates must contain at least one state`);
  }
}

export class D1TermDepositRepository implements TermDepositRepository {
  constructor(private readonly db: D1Database) {}

  async insertDraft(input: CreateDraftInput): Promise<TermDepositRecord> {
    const stmt = this.db
      .prepare(
        `INSERT INTO term_deposits (
           account_id, bank_id, holder_member_id, currency_code,
           product_name, nickname, certificate_last_four,
           principal_minor, start_date, maturity_date,
           annual_rate_scaled, tax_rate_scaled, fees_minor,
           interest_method, day_count_basis,
           bank_quoted_gross_interest_minor,
           bank_quoted_net_interest_minor,
           bank_quoted_maturity_amount_minor,
           maturity_instruction, maturity_settlement_account_id,
           predecessor_deposit_id,
           source_evidence_ref
         ) VALUES (
           ?, ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?,
           ?, ?,
           ?, ?, ?,
           ?, ?,
           ?,
           ?
         )
         RETURNING *`
      )
      .bind(
        input.accountId,
        input.bankId,
        input.holderMemberId,
        input.currencyCode,
        input.productName,
        input.nickname ?? null,
        input.certificateLastFour,
        input.principalMinor,
        input.startDate,
        input.maturityDate,
        input.annualRateScaled,
        input.taxRateScaled,
        input.feesMinor,
        input.interestMethod,
        input.dayCountBasis,
        input.bankQuotedGrossInterestMinor ?? null,
        input.bankQuotedNetInterestMinor ?? null,
        input.bankQuotedMaturityAmountMinor ?? null,
        input.maturityInstruction ?? "PENDING",
        input.maturitySettlementAccountId ?? null,
        input.predecessorDepositId ?? null,
        input.sourceEvidenceRef ?? null
      );
    const row = await stmt.first<TermDepositRow>();
    if (row === null) {
      throw new Error("insertDraft: RETURNING produced no row");
    }
    return rowToRecord(row);
  }

  async findById(id: number): Promise<TermDepositRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM term_deposits WHERE id = ?")
      .bind(id)
      .first<TermDepositRow>();
    return row === null ? null : rowToRecord(row);
  }

  async listByHolder(memberId: number): Promise<TermDepositRecord[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM term_deposits WHERE holder_member_id = ? " + "ORDER BY maturity_date ASC, id ASC"
      )
      .bind(memberId)
      .all<TermDepositRow>();
    return result.results.map(rowToRecord);
  }

  async listAllActiveDeposits(): Promise<TermDepositRecord[]> {
    const result = await this.db
      .prepare("SELECT * FROM term_deposits WHERE state = 'ACTIVE' " + "ORDER BY maturity_date ASC, id ASC")
      .all<TermDepositRow>();
    return result.results.map(rowToRecord);
  }

  async listMaturedUnresolvedDeposits(): Promise<TermDepositRecord[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM term_deposits WHERE state = 'MATURED_ACTION_REQUIRED' " +
          "ORDER BY maturity_date ASC, id ASC"
      )
      .all<TermDepositRow>();
    return result.results.map(rowToRecord);
  }

  async updateEditableFacts(
    id: number,
    patch: EditableFactsPatch,
    allowedStates: readonly TermDepositState[]
  ): Promise<TermDepositRecord> {
    assertAllowedStates("updateEditableFacts", allowedStates);
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.productName !== undefined) {
      sets.push("product_name = ?");
      params.push(patch.productName);
    }
    if (patch.nickname !== undefined) {
      sets.push("nickname = ?");
      params.push(patch.nickname);
    }
    if (patch.certificateLastFour !== undefined) {
      sets.push("certificate_last_four = ?");
      params.push(patch.certificateLastFour);
    }
    if (patch.principalMinor !== undefined) {
      sets.push("principal_minor = ?");
      params.push(patch.principalMinor);
    }
    if (patch.startDate !== undefined) {
      sets.push("start_date = ?");
      params.push(patch.startDate);
    }
    if (patch.maturityDate !== undefined) {
      sets.push("maturity_date = ?");
      params.push(patch.maturityDate);
    }
    if (patch.annualRateScaled !== undefined) {
      sets.push("annual_rate_scaled = ?");
      params.push(patch.annualRateScaled);
    }
    if (patch.taxRateScaled !== undefined) {
      sets.push("tax_rate_scaled = ?");
      params.push(patch.taxRateScaled);
    }
    if (patch.feesMinor !== undefined) {
      sets.push("fees_minor = ?");
      params.push(patch.feesMinor);
    }
    if (patch.interestMethod !== undefined) {
      sets.push("interest_method = ?");
      params.push(patch.interestMethod);
    }
    if (patch.dayCountBasis !== undefined) {
      sets.push("day_count_basis = ?");
      params.push(patch.dayCountBasis);
    }
    if (patch.maturityInstruction !== undefined) {
      sets.push("maturity_instruction = ?");
      params.push(patch.maturityInstruction);
    }
    if (patch.maturitySettlementAccountId !== undefined) {
      sets.push("maturity_settlement_account_id = ?");
      params.push(patch.maturitySettlementAccountId);
    }
    if (patch.sourceEvidenceRef !== undefined) {
      sets.push("source_evidence_ref = ?");
      params.push(patch.sourceEvidenceRef);
    }

    if (sets.length === 0) {
      // Nothing to update — return current row unchanged.
      const current = await this.findById(id);
      if (current === null) throw new Error(`updateEditableFacts: deposit ${id} not found`);
      return current;
    }

    sets.push("updated_at = datetime('now', 'utc')");

    const placeholders = allowedStates.map(() => "?").join(", ");
    const sql =
      `UPDATE term_deposits SET ${sets.join(", ")} ` +
      `WHERE id = ? AND state IN (${placeholders}) ` +
      `RETURNING *`;
    params.push(id, ...allowedStates);

    const row = await this.db
      .prepare(sql)
      .bind(...(params as never[]))
      .first<TermDepositRow>();
    if (row === null) {
      throw new Error(
        `updateEditableFacts: deposit ${id} not found or not in allowed states [${allowedStates.join(", ")}]`
      );
    }
    return rowToRecord(row);
  }

  async updateBankQuotedFacts(
    id: number,
    patch: BankQuotedPatch,
    allowedStates: readonly TermDepositState[]
  ): Promise<TermDepositRecord> {
    assertAllowedStates("updateBankQuotedFacts", allowedStates);
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.bankQuotedGrossInterestMinor !== undefined) {
      sets.push("bank_quoted_gross_interest_minor = ?");
      params.push(patch.bankQuotedGrossInterestMinor);
    }
    if (patch.bankQuotedNetInterestMinor !== undefined) {
      sets.push("bank_quoted_net_interest_minor = ?");
      params.push(patch.bankQuotedNetInterestMinor);
    }
    if (patch.bankQuotedMaturityAmountMinor !== undefined) {
      sets.push("bank_quoted_maturity_amount_minor = ?");
      params.push(patch.bankQuotedMaturityAmountMinor);
    }

    if (sets.length === 0) {
      const current = await this.findById(id);
      if (current === null) throw new Error(`updateBankQuotedFacts: deposit ${id} not found`);
      return current;
    }

    sets.push("updated_at = datetime('now', 'utc')");

    const placeholders = allowedStates.map(() => "?").join(", ");
    const sql =
      `UPDATE term_deposits SET ${sets.join(", ")} ` +
      `WHERE id = ? AND state IN (${placeholders}) ` +
      `RETURNING *`;
    params.push(id, ...allowedStates);

    const row = await this.db
      .prepare(sql)
      .bind(...(params as never[]))
      .first<TermDepositRow>();
    if (row === null) {
      throw new Error(
        `updateBankQuotedFacts: deposit ${id} not found or not in allowed states [${allowedStates.join(", ")}]`
      );
    }
    return rowToRecord(row);
  }

  async updateMaturityInstruction(
    id: number,
    instruction: MaturityInstruction,
    settlementAccountId: number | null,
    allowedStates: readonly TermDepositState[]
  ): Promise<TermDepositRecord> {
    assertAllowedStates("updateMaturityInstruction", allowedStates);
    const placeholders = allowedStates.map(() => "?").join(", ");
    const sql =
      `UPDATE term_deposits SET maturity_instruction = ?, ` +
      `maturity_settlement_account_id = ?, updated_at = datetime('now', 'utc') ` +
      `WHERE id = ? AND state IN (${placeholders}) RETURNING *`;
    const params: unknown[] = [instruction, settlementAccountId, id, ...allowedStates];
    const row = await this.db
      .prepare(sql)
      .bind(...(params as never[]))
      .first<TermDepositRow>();
    if (row === null) {
      throw new Error(
        `updateMaturityInstruction: deposit ${id} not found or not in allowed states [${allowedStates.join(", ")}]`
      );
    }
    return rowToRecord(row);
  }

  async transitionState(
    id: number,
    expectedFrom: TermDepositState,
    to: TermDepositState
  ): Promise<{ affected: number; record: TermDepositRecord | null }> {
    const edge = `${expectedFrom}->${to}`;
    if (!M1B_TRANSITION_EDGES.has(edge)) {
      throw new Error(`transitionState: edge ${edge} is not available in M1B`);
    }
    const sql =
      "UPDATE term_deposits SET state = ?, updated_at = datetime('now', 'utc') " +
      "WHERE id = ? AND state = ? RETURNING *";
    const row = await this.db.prepare(sql).bind(to, id, expectedFrom).first<TermDepositRow>();
    if (row === null) {
      return { affected: 0, record: null };
    }
    return { affected: 1, record: rowToRecord(row) };
  }

  async loadPredecessor(id: number): Promise<TermDepositRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT t2.* FROM term_deposits t1
         INNER JOIN term_deposits t2 ON t1.predecessor_deposit_id = t2.id
         WHERE t1.id = ?`
      )
      .bind(id)
      .first<TermDepositRow>();
    return row === null ? null : rowToRecord(row);
  }

  async loadSuccessor(id: number): Promise<TermDepositRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT t2.* FROM term_deposits t1
         INNER JOIN term_deposits t2 ON t2.predecessor_deposit_id = t1.id
         WHERE t1.id = ?
         ORDER BY t2.id ASC
         LIMIT 1`
      )
      .bind(id)
      .first<TermDepositRow>();
    return row === null ? null : rowToRecord(row);
  }

  async loadAccountContext(accountId: number): Promise<AccountContext | null> {
    const row = await this.db
      .prepare(
        "SELECT id, account_type, member_id, bank_id, currency_code, active, archived " +
          "FROM accounts WHERE id = ?"
      )
      .bind(accountId)
      .first<{
        id: number;
        account_type: string;
        member_id: number;
        bank_id: number | null;
        currency_code: string;
        active: number;
        archived: number;
      }>();
    if (row === null) return null;
    return {
      accountId: row.id,
      accountType: row.account_type,
      memberId: row.member_id,
      bankId: row.bank_id,
      currencyCode: row.currency_code,
      active: row.active,
      archived: row.archived,
    };
  }

  async loadMemberContext(memberId: number): Promise<MemberContext | null> {
    const row = await this.db
      .prepare("SELECT id, active FROM household_members WHERE id = ?")
      .bind(memberId)
      .first<{ id: number; active: number }>();
    if (row === null) return null;
    return { memberId: row.id, active: row.active };
  }

  async loadBankContext(bankId: number): Promise<BankContext | null> {
    const row = await this.db
      .prepare("SELECT id, active FROM banks WHERE id = ?")
      .bind(bankId)
      .first<{ id: number; active: number }>();
    if (row === null) return null;
    return { bankId: row.id, active: row.active };
  }

  async loadCurrencyContext(code: string): Promise<CurrencyContext | null> {
    const row = await this.db
      .prepare("SELECT code, active FROM currencies WHERE code = ?")
      .bind(code)
      .first<{ code: string; active: number }>();
    if (row === null) return null;
    return { code: row.code, active: row.active };
  }

  async loadDepositContext(id: number): Promise<{ id: number } | null> {
    const row = await this.db
      .prepare("SELECT id FROM term_deposits WHERE id = ?")
      .bind(id)
      .first<{ id: number }>();
    return row ?? null;
  }
}
