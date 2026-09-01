/**
 * Test helpers for seeding parent rows that term-deposit tests need.
 *
 * Returns plain id values; tests pass them into CreateDraftInput. The
 * `D1TermDepositRepository` looks up the linked account/member/bank/
 * currency context at write time, so these IDs must exist in the test DB.
 *
 * All names/IDs are obviously synthetic (clearly fake numerics, "test-bank"
 * currency, "Test Owner"/"Test Member" display names).
 */

import type { FakeD1Database } from "../../src/adapters/d1/fake.js";

export interface SeededParents {
  memberId: number;
  otherMemberId: number;
  bankId: number;
  otherBankId: number;
  currency: string;
  otherCurrency: string;
  accountId: number;
  /** A second TERM_DEPOSIT account belonging to the same member, different bank/currency. */
  accountId2: number;
}

export async function seedDepositParents(db: FakeD1Database): Promise<SeededParents> {
  // PHP and the six system banks are seeded by migration 0001.
  // Add a non-system test bank we control.
  const b1 = await db
    .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, ?)")
    .bind("test-bank", "Test Bank A", 0)
    .run();
  const b2 = await db
    .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, ?)")
    .bind("test-bank-2", "Test Bank B", 0)
    .run();

  // Members
  const m1 = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Test Owner One")
    .run();
  const m2 = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("MEMBER", "Test Member Two")
    .run();

  // Term-deposit accounts: the only account_type that matters for M1B.
  const a1 = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(m1.meta.last_row_id, b1.meta.last_row_id, "PHP", "TERM_DEPOSIT", "Test TD 1")
    .run();
  const a2 = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(m1.meta.last_row_id, b2.meta.last_row_id, "EUR", "TERM_DEPOSIT", "Test TD EUR")
    .run();

  return {
    memberId: Number(m1.meta.last_row_id),
    otherMemberId: Number(m2.meta.last_row_id),
    bankId: Number(b1.meta.last_row_id),
    otherBankId: Number(b2.meta.last_row_id),
    currency: "PHP",
    otherCurrency: "EUR",
    accountId: Number(a1.meta.last_row_id),
    accountId2: Number(a2.meta.last_row_id),
  };
}

/**
 * Insert a regular BANK account so we can verify that the service rejects
 * non-TERM_DEPOSIT accounts. Returns the id.
 */
export async function seedBankAccount(db: FakeD1Database, memberId: number, bankId: number): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(memberId, bankId, "PHP", "BANK", "Test Checking")
    .run();
  return Number(result.meta.last_row_id);
}

/**
 * Insert an inactive household member so tests can verify the active check.
 * Returns the id.
 */
export async function seedInactiveMember(db: FakeD1Database): Promise<number> {
  const result = await db
    .prepare("INSERT INTO household_members (role, display_name, active) VALUES (?, ?, 0)")
    .bind("MEMBER", "Inactive Test Member")
    .run();
  return Number(result.meta.last_row_id);
}
