/**
 * D1 implementation of the accounts repository.
 *
 * All SQL is parameterized. No raw D1 binding escapes this module — the
 * application service sees only the abstract `AccountRepository` port.
 *
 * Row mapping returns money columns directly. The TypeScript row type
 * guarantees they are numbers; SQLite INTEGER storage keeps them lossless.
 * No arithmetic happens here.
 */

import type { AccountType } from "../../domain/ledger/index.js";
import type { D1Database } from "../../adapters/d1/types.js";
import type {
  AccountContext,
  AccountRepository,
  BankContext,
  CurrencyContext,
  MemberContext,
} from "./repository.js";
import type { AccountRecord, CreateAccountInput, UpdateAccountPatch } from "./types.js";

// ── Row type as stored in SQLite ────────────────────────────────────────────

interface AccountRow {
  id: number;
  member_id: number;
  bank_id: number | null;
  currency_code: string;
  account_type: string;
  nickname: string;
  opening_balance_minor: number;
  active: number;
  archived: number;
  last_reconciled_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    bankId: row.bank_id,
    currencyCode: row.currency_code,
    accountType: row.account_type as AccountType,
    nickname: row.nickname,
    openingBalanceMinor: row.opening_balance_minor,
    active: row.active,
    archived: row.archived,
    lastReconciledAt: row.last_reconciled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── D1 Repository ───────────────────────────────────────────────────────────

export class D1AccountRepository implements AccountRepository {
  constructor(private readonly db: D1Database) {}

  async insert(input: CreateAccountInput): Promise<AccountRecord> {
    const stmt = this.db
      .prepare(
        `INSERT INTO accounts (
           member_id, bank_id, currency_code, account_type,
           nickname, opening_balance_minor
         ) VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .bind(
        input.memberId,
        input.bankId ?? null,
        input.currencyCode,
        input.accountType,
        input.nickname,
        input.openingBalanceMinor
      );
    const row = await stmt.first<AccountRow>();
    if (row === null) {
      throw new Error("insert: RETURNING produced no row");
    }
    return rowToRecord(row);
  }

  async findById(id: number): Promise<AccountRecord | null> {
    const row = await this.db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<AccountRow>();
    return row === null ? null : rowToRecord(row);
  }

  async listByMember(memberId: number): Promise<AccountRecord[]> {
    const result = await this.db
      .prepare("SELECT * FROM accounts WHERE member_id = ? ORDER BY id ASC")
      .bind(memberId)
      .all<AccountRow>();
    return result.results.map(rowToRecord);
  }

  async listAll(): Promise<AccountRecord[]> {
    const result = await this.db.prepare("SELECT * FROM accounts ORDER BY id ASC").all<AccountRow>();
    return result.results.map(rowToRecord);
  }

  async update(id: number, patch: UpdateAccountPatch): Promise<AccountRecord> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.nickname !== undefined) {
      sets.push("nickname = ?");
      params.push(patch.nickname);
    }
    if (patch.openingBalanceMinor !== undefined) {
      sets.push("opening_balance_minor = ?");
      params.push(patch.openingBalanceMinor);
    }
    if (patch.bankId !== undefined) {
      sets.push("bank_id = ?");
      params.push(patch.bankId);
    }

    if (sets.length === 0) {
      const current = await this.findById(id);
      if (current === null) throw new Error(`update: account ${id} not found`);
      return current;
    }

    sets.push("updated_at = datetime('now', 'utc')");

    const sql = `UPDATE accounts SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
    params.push(id);

    const row = await this.db
      .prepare(sql)
      .bind(...(params as never[]))
      .first<AccountRow>();
    if (row === null) {
      throw new Error(`update: account ${id} not found`);
    }
    return rowToRecord(row);
  }

  async setActive(id: number, active: number): Promise<AccountRecord> {
    const row = await this.db
      .prepare(
        `UPDATE accounts
         SET active = ?, updated_at = datetime('now', 'utc')
         WHERE id = ?
         RETURNING *`
      )
      .bind(active, id)
      .first<AccountRow>();
    if (row === null) {
      throw new Error(`setActive: account ${id} not found`);
    }
    return rowToRecord(row);
  }

  async setArchived(id: number, archived: number): Promise<AccountRecord> {
    const row = await this.db
      .prepare(
        `UPDATE accounts
         SET archived = ?, updated_at = datetime('now', 'utc')
         WHERE id = ?
         RETURNING *`
      )
      .bind(archived, id)
      .first<AccountRow>();
    if (row === null) {
      throw new Error(`setArchived: account ${id} not found`);
    }
    return rowToRecord(row);
  }

  async loadAccountContext(accountId: number): Promise<AccountContext | null> {
    const row = await this.db
      .prepare(
        "SELECT id, member_id, bank_id, currency_code, account_type, active, archived " +
          "FROM accounts WHERE id = ?"
      )
      .bind(accountId)
      .first<{
        id: number;
        member_id: number;
        bank_id: number | null;
        currency_code: string;
        account_type: string;
        active: number;
        archived: number;
      }>();
    if (row === null) return null;
    return {
      accountId: row.id,
      memberId: row.member_id,
      bankId: row.bank_id,
      currencyCode: row.currency_code,
      accountType: row.account_type as AccountType,
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

  async loadAccountType(accountId: number): Promise<AccountType | null> {
    const row = await this.db
      .prepare("SELECT account_type FROM accounts WHERE id = ?")
      .bind(accountId)
      .first<{ account_type: string }>();
    return row === null ? null : (row.account_type as AccountType);
  }
}
