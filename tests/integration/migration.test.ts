/**
 * migration.test.ts
 *
 * Verifies that D1 migrations:
 * - Apply cleanly from zero on a fresh database (using better-sqlite3 for tests).
 * - Create all expected foundation tables.
 * - Seed banks, currencies and categories correctly.
 * - Record migration metadata.
 *
 * Uses better-sqlite3 (synchronous SQLite) to stay CI-friendly without
 * requiring a real Cloudflare D1 environment.
 * D1's SQL dialect is compatible with SQLite for DDL/DML used here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

function applyMigrations(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexicographic = 0001, 0002, ...

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    db.exec(sql);
  }
}

describe("D1 migrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // Enable foreign keys (SQLite default is off; D1 has them on)
    db.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    db.close();
  });

  it("applies all migrations without error", () => {
    expect(() => applyMigrations(db)).not.toThrow();
  });

  it("creates migration_metadata table", () => {
    applyMigrations(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_metadata'")
      .get();
    expect(row).toBeDefined();
  });

  it("creates household_members table", () => {
    applyMigrations(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='household_members'")
      .get();
    expect(row).toBeDefined();
  });

  it("creates telegram_identities table", () => {
    applyMigrations(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_identities'")
      .get();
    expect(row).toBeDefined();
  });

  it("creates currencies table", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='currencies'").get();
    expect(row).toBeDefined();
  });

  it("creates banks table", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='banks'").get();
    expect(row).toBeDefined();
  });

  it("creates accounts table", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get();
    expect(row).toBeDefined();
  });

  it("creates categories table", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='categories'").get();
    expect(row).toBeDefined();
  });

  it("seeds PHP currency", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT * FROM currencies WHERE code = 'PHP'").get() as
      | { minor_unit_scale: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.minor_unit_scale).toBe(2);
  });

  it("seeds BDO bank", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT * FROM banks WHERE slug = 'bdo'").get() as
      | { is_system: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.is_system).toBe(1);
  });

  it("seeds BPI bank", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT * FROM banks WHERE slug = 'bpi'").get();
    expect(row).toBeDefined();
  });

  it("seeds Metrobank bank", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT * FROM banks WHERE slug = 'metrobank'").get();
    expect(row).toBeDefined();
  });

  it("seeds PNB bank", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT * FROM banks WHERE slug = 'pnb'").get();
    expect(row).toBeDefined();
  });

  it("seeds HSBC bank", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT * FROM banks WHERE slug = 'hsbc'").get();
    expect(row).toBeDefined();
  });

  it("seeds Other/custom bank", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT * FROM banks WHERE slug = 'other'").get();
    expect(row).toBeDefined();
  });

  it("seeds at least 20 expense categories", () => {
    applyMigrations(db);
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM categories").get() as { cnt: number }).cnt;
    expect(count).toBeGreaterThanOrEqual(20);
  });

  it("records migration metadata for version 1", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT * FROM migration_metadata WHERE version = 1").get() as
      | { name: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe("0001_foundation");
  });

  it("household_members role column enforces OWNER/MEMBER constraint", () => {
    applyMigrations(db);
    expect(() => {
      db.prepare("INSERT INTO household_members (role, display_name) VALUES ('ADMIN', 'Test')").run();
    }).toThrow();
  });

  it("banks slug column is unique", () => {
    applyMigrations(db);
    expect(() => {
      db.prepare("INSERT INTO banks (slug, name, is_system) VALUES ('bdo', 'Duplicate BDO', 1)").run();
    }).toThrow();
  });

  it("accounts currency_code references currencies", () => {
    applyMigrations(db);
    // Add a member first
    db.prepare("INSERT INTO household_members (role, display_name) VALUES ('OWNER', 'Test Owner')").run();
    // Attempt to insert account with non-existent currency — must fail with FK enabled
    expect(() => {
      db.prepare(
        `
        INSERT INTO accounts (member_id, currency_code, account_type, nickname)
        VALUES (1, 'XYZ', 'BANK', 'Test Account')
      `
      ).run();
    }).toThrow();
  });

  it("enforces one Telegram identity per household member", () => {
    applyMigrations(db);
    const member = db
      .prepare("INSERT INTO household_members (role, display_name) VALUES ('OWNER', 'Test Owner')")
      .run();

    db.prepare("INSERT INTO telegram_identities (member_id, telegram_user_id) VALUES (?, ?)").run(
      member.lastInsertRowid,
      "100000001"
    );

    expect(() => {
      db.prepare("INSERT INTO telegram_identities (member_id, telegram_user_id) VALUES (?, ?)").run(
        member.lastInsertRowid,
        "100000002"
      );
    }).toThrow();
  });

  // ── Migration 0003: term_deposits (M1A) ───────────────────────────────────

  /** Insert the minimum set of parents needed before term_deposits. */
  function seedDepositParents(): {
    memberId: number;
    bankId: number;
    accountId: number;
    currency: string;
  } {
    db.prepare("INSERT INTO currencies (code, name, minor_unit_scale) VALUES ('XYZ', 'Test', 2)").run();
    db.prepare("INSERT INTO banks (slug, name, is_system) VALUES ('test-bank', 'Test Bank', 0)").run();
    const member = db
      .prepare("INSERT INTO household_members (role, display_name) VALUES ('OWNER', 'Test Owner')")
      .run();
    const bank = db.prepare("SELECT id FROM banks WHERE slug = 'test-bank'").get() as { id: number };
    const account = db
      .prepare(
        "INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname) VALUES (?, ?, ?, 'TERM_DEPOSIT', 'Test TD')"
      )
      .run(member.lastInsertRowid, bank.id, "XYZ");
    return {
      memberId: Number(member.lastInsertRowid),
      bankId: bank.id,
      accountId: Number(account.lastInsertRowid),
      currency: "XYZ",
    };
  }

  it("creates term_deposits table", () => {
    applyMigrations(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='term_deposits'")
      .get();
    expect(row).toBeDefined();
  });

  it("records migration metadata for version 3", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT * FROM migration_metadata WHERE version = 3").get() as
      | { name: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe("0003_term_deposits");
  });

  it("term_deposits state column defaults to DRAFT", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    const r = db
      .prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '1234', 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365')`
      )
      .run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    const row = db.prepare("SELECT state FROM term_deposits WHERE id = ?").get(r.lastInsertRowid) as {
      state: string;
    };
    expect(row.state).toBe("DRAFT");
  });

  it("term_deposits state CHECK constraint enforces the lifecycle enum", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    expect(() => {
      db.prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis, state)
         VALUES (?, ?, ?, ?, ?, '1234', 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365', 'NOT_A_STATE')`
      ).run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    }).toThrow();
  });

  it("term_deposits interest_method CHECK constraint enforces SIMPLE/COMPOUND", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    expect(() => {
      db.prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '1234', 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'WEEKLY', 'ACT_365')`
      ).run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    }).toThrow();
  });

  it("term_deposits day_count_basis CHECK constraint enforces ACT_365/ACT_360/ACT_ACT", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    expect(() => {
      db.prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '1234', 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_364')`
      ).run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    }).toThrow();
  });

  it("term_deposits certificate_last_four rejects non-4-character input", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    expect(() => {
      db.prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '123', 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365')`
      ).run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    }).toThrow();
  });

  it("term_deposits certificate_last_four rejects non-digit characters", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    expect(() => {
      db.prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '12A4', 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365')`
      ).run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    }).toThrow();
  });

  it("term_deposits rejects negative principal", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    expect(() => {
      db.prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '1234', -1, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365')`
      ).run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    }).toThrow();
  });

  it("term_deposits rejects maturity_date earlier than start_date", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    expect(() => {
      db.prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '1234', 1000000, '2026-04-01', '2026-01-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365')`
      ).run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    }).toThrow();
  });

  it("term_deposits has indexes for account, state, maturity_date, holder_member_id", () => {
    applyMigrations(db);
    const expected = [
      "idx_term_deposits_account_id",
      "idx_term_deposits_state",
      "idx_term_deposits_maturity_date",
      "idx_term_deposits_holder_member_id",
    ];
    for (const idx of expected) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(idx);
      expect(row, `expected index ${idx} to exist`).toBeDefined();
    }
  });

  it("term_deposits predecessor/successor self-link CHECK constraint prevents self-loop", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    const r = db
      .prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '1234', 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365')`
      )
      .run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    const id = Number(r.lastInsertRowid);
    expect(() => {
      db.prepare("UPDATE term_deposits SET successor_deposit_id = ? WHERE id = ?").run(id, id);
    }).toThrow();
    expect(() => {
      db.prepare("UPDATE term_deposits SET predecessor_deposit_id = ? WHERE id = ?").run(id, id);
    }).toThrow();
  });

  // ── Migration 0005: term_deposit_reminders (M1C) ──────────────────────────

  it("creates term_deposit_reminders table", () => {
    applyMigrations(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='term_deposit_reminders'")
      .get();
    expect(row).toBeDefined();
  });

  it("records migration metadata for version 5", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT * FROM migration_metadata WHERE version = 5").get() as
      | { name: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe("0005_term_deposit_reminders");
  });

  it("term_deposit_reminders offset_kind CHECK constraint enforces D-30/D-7/D-1/D0", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    const deposit = db
      .prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '1234', 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365')`
      )
      .run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    const depositId = Number(deposit.lastInsertRowid);
    expect(() => {
      db.prepare(
        `INSERT INTO term_deposit_reminders
           (deposit_id, offset_kind, target_date)
         VALUES (?, 'NOT_AN_OFFSET', '2026-03-02')`
      ).run(depositId);
    }).toThrow();
  });

  it("term_deposit_reminders status CHECK constraint enforces PENDING/MUTED/DELIVERED/CANCELLED", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    const deposit = db
      .prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '1234', 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365')`
      )
      .run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    const depositId = Number(deposit.lastInsertRowid);
    expect(() => {
      db.prepare(
        `INSERT INTO term_deposit_reminders
           (deposit_id, offset_kind, target_date, status)
         VALUES (?, 'D0', '2026-04-01', 'INVALID_STATUS')`
      ).run(depositId);
    }).toThrow();
  });

  it("term_deposit_reminders UNIQUE (deposit_id, offset_kind) prevents duplicates", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    const deposit = db
      .prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '1234', 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365')`
      )
      .run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    const depositId = Number(deposit.lastInsertRowid);

    db.prepare(
      `INSERT INTO term_deposit_reminders (deposit_id, offset_kind, target_date) VALUES (?, 'D0', '2026-04-01')`
    ).run(depositId);

    expect(() => {
      db.prepare(
        `INSERT INTO term_deposit_reminders (deposit_id, offset_kind, target_date) VALUES (?, 'D0', '2026-04-01')`
      ).run(depositId);
    }).toThrow();
  });

  it("term_deposit_reminders cascades on deposit delete", () => {
    applyMigrations(db);
    const p = seedDepositParents();
    const deposit = db
      .prepare(
        `INSERT INTO term_deposits
         (account_id, bank_id, holder_member_id, currency_code,
          product_name, certificate_last_four,
          principal_minor, start_date, maturity_date,
          annual_rate_scaled, tax_rate_scaled, fees_minor,
          interest_method, day_count_basis)
         VALUES (?, ?, ?, ?, ?, '1234', 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365')`
      )
      .run(p.accountId, p.bankId, p.memberId, p.currency, "Test Product");
    const depositId = Number(deposit.lastInsertRowid);
    db.prepare(
      `INSERT INTO term_deposit_reminders (deposit_id, offset_kind, target_date) VALUES (?, 'D0', '2026-04-01')`
    ).run(depositId);

    db.prepare("DELETE FROM term_deposits WHERE id = ?").run(depositId);

    const cnt = (
      db
        .prepare("SELECT COUNT(*) as cnt FROM term_deposit_reminders WHERE deposit_id = ?")
        .get(depositId) as { cnt: number }
    ).cnt;
    expect(cnt).toBe(0);
  });

  // ── Migration 0017: settlement-closure atomic boundary (M3C) ───────────────

  /**
   * Seed the minimum parents and a SETTLED-ELIGIBLE review session for the
   * settlement-closure boundary tests. Returns ids for all entities the
   * closure command needs.
   */
  function seedSettlementClosureFixture(opts?: {
    depositState?: string;
    confirmingMemberRole?: "OWNER" | "MEMBER";
    confirmingMemberActive?: number;
    depositCurrency?: string;
    settlementCurrency?: string;
    settlementArchived?: number;
    settlementActive?: number;
    documentKind?: "SETTLEMENT_EVIDENCE" | "RECEIPT";
    sessionStatus?: "PENDING_REVIEW" | "CONFIRMED" | "REJECTED";
    sessionKey?: string | null;
  }): {
    ownerMemberId: number;
    otherMemberId: number;
    bankId: number;
    tdAccountId: number;
    settlementAccountId: number;
    otherSettlementAccountId: number;
    documentId: number;
    depositId: number;
    sessionId: number;
    closureKey: string;
    currency: string;
    otherCurrency: string;
  } {
    db.prepare("INSERT INTO currencies (code, name, minor_unit_scale) VALUES ('XYZ', 'Test', 2)").run();
    db.prepare("INSERT INTO currencies (code, name, minor_unit_scale) VALUES ('ZYX', 'Other', 2)").run();
    db.prepare("INSERT INTO banks (slug, name, is_system) VALUES ('test-bank', 'Test Bank', 0)").run();
    const owner = db
      .prepare("INSERT INTO household_members (role, display_name) VALUES ('OWNER', 'Test Owner')")
      .run();
    const otherMember = db
      .prepare("INSERT INTO household_members (role, display_name, active) VALUES (?, 'Test Member', ?)")
      .run(opts?.confirmingMemberRole ?? "OWNER", opts?.confirmingMemberActive ?? 1);
    const bank = db.prepare("SELECT id FROM banks WHERE slug = 'test-bank'").get() as { id: number };
    const ownerId = Number(owner.lastInsertRowid);
    const otherId = Number(otherMember.lastInsertRowid);
    const confirmingId = ownerId; // the confirming member for SETTLEMENT is OWNER

    // Source: TERM_DEPOSIT account owned by OWNER in 'XYZ'
    const tdAccount = db
      .prepare(
        `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
         VALUES (?, ?, ?, 'TERM_DEPOSIT', 'TD Source')`
      )
      .run(ownerId, bank.id, "XYZ");

    // Destination: BANK account in 'XYZ' (or whatever the test configures)
    const settlement = db
      .prepare(
        `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname, active, archived)
         VALUES (?, ?, ?, 'BANK', 'Settlement', ?, ?)`
      )
      .run(
        ownerId,
        bank.id,
        opts?.settlementCurrency ?? "XYZ",
        opts?.settlementActive ?? 1,
        opts?.settlementArchived ?? 0
      );

    // Other-currency settlement account (for wrong-currency test)
    const otherSettlement = db
      .prepare(
        `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
         VALUES (?, ?, 'ZYX', 'BANK', 'Other Settlement')`
      )
      .run(ownerId, bank.id);

    // Document of the configured kind
    const doc = db
      .prepare(
        `INSERT INTO documents
           (kind, owner_member_id, uploader_member_id, content_type, byte_size, sha256_hex, object_key)
         VALUES (?, ?, ?, 'image/png', 1024,
                 '0000000000000000000000000000000000000000000000000000000000000000',
                 'docs/test/' || ?)`
      )
      .run(
        opts?.documentKind ?? "SETTLEMENT_EVIDENCE",
        ownerId,
        ownerId,
        `doc-${Date.now()}-${Math.random()}`
      );

    // Term deposit in MATURED_ACTION_REQUIRED state (or whatever the test configures)
    const deposit = db
      .prepare(
        `INSERT INTO term_deposits
           (account_id, bank_id, holder_member_id, currency_code,
            product_name, certificate_last_four,
            principal_minor, start_date, maturity_date,
            annual_rate_scaled, tax_rate_scaled, fees_minor,
            interest_method, day_count_basis, state)
         VALUES (?, ?, ?, ?, 'Test Product', '1234',
                 1000000, '2026-01-01', '2026-04-01',
                 50000, 200000, 0, 'SIMPLE', 'ACT_365', ?)`
      )
      .run(
        Number(tdAccount.lastInsertRowid),
        bank.id,
        ownerId,
        opts?.depositCurrency ?? "XYZ",
        opts?.depositState ?? "MATURED_ACTION_REQUIRED"
      );

    const closureKey = `closure-test-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const sessionKey = opts?.sessionKey !== undefined ? opts.sessionKey : closureKey;

    // Review session of kind SETTLEMENT, linked to the deposit, with the
    // configured post_idempotency_key (default = closureKey). The session
    // is normally PENDING_REVIEW (or whatever the test configures).
    const session = db
      .prepare(
        `INSERT INTO review_sessions
           (kind, status, document_id, deposit_id, confirming_member_id,
            review_decision_json, candidate_payload_json, corrected_payload_json,
            post_idempotency_key)
         VALUES ('SETTLEMENT', ?, ?, ?, ?, '{}', '{}', '{}', ?)`
      )
      .run(
        opts?.sessionStatus ?? "PENDING_REVIEW",
        Number(doc.lastInsertRowid),
        Number(deposit.lastInsertRowid),
        confirmingId,
        sessionKey
      );

    return {
      ownerMemberId: ownerId,
      otherMemberId: otherId,
      bankId: bank.id,
      tdAccountId: Number(tdAccount.lastInsertRowid),
      settlementAccountId: Number(settlement.lastInsertRowid),
      otherSettlementAccountId: Number(otherSettlement.lastInsertRowid),
      documentId: Number(doc.lastInsertRowid),
      depositId: Number(deposit.lastInsertRowid),
      sessionId: Number(session.lastInsertRowid),
      closureKey,
      currency: "XYZ",
      otherCurrency: "ZYX",
    };
  }

  /** Perform the atomic settlement closure as the application service would. */
  function performSettlementClosure(opts: {
    db: Database.Database;
    sessionId: number;
    depositId: number;
    depositSourceAccountId: number;
    documentId: number;
    confirmingMemberId: number;
    settlementAccountId: number;
    currency: string;
    principalMinor: number;
    grossInterestMinor: number;
    taxMinor: number;
    penaltyFeesMinor: number;
    receivedTotalMinor: number;
    actualSettlementDate: string;
    closureKey: string;
    includeTax?: boolean;
    includePenalty?: boolean;
    /** Inject a failing statement BEFORE the settlement_closures INSERT. */
    injectFailure?: "bad_ledger_entry";
  }): { closureId: number; principalTxId: number } {
    const {
      sessionId,
      depositId,
      documentId,
      confirmingMemberId,
      settlementAccountId,
      currency,
      principalMinor,
      grossInterestMinor,
      taxMinor,
      penaltyFeesMinor,
      receivedTotalMinor,
      actualSettlementDate,
      closureKey,
      includeTax,
      includePenalty,
      injectFailure,
    } = opts;

    const tx = db.transaction(() => {
      // T1 — principal TRANSFER: TD source → settlement destination
      const txPrincipal = db
        .prepare(
          `INSERT INTO transactions
             (member_id, transaction_type, currency_code, amount_minor,
              occurred_on, description, idempotency_key, source_evidence_ref)
           VALUES (?, 'TRANSFER', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          confirmingMemberId,
          currency,
          principalMinor,
          actualSettlementDate,
          "TD principal transfer",
          `settlement-principal:${closureKey}`,
          `doc:${documentId}`
        );
      const principalTxId = Number(txPrincipal.lastInsertRowid);

      // Source TD account: CREDIT (money leaving)
      db.prepare(
        `INSERT INTO ledger_entries
           (transaction_id, account_id, direction, amount_minor, currency_code, memo)
         VALUES (?, ?, 'CREDIT', ?, ?, 'TD principal out')`
      ).run(principalTxId, opts.depositSourceAccountId, principalMinor, currency);

      // Settlement destination: DEBIT (money arriving)
      db.prepare(
        `INSERT INTO ledger_entries
           (transaction_id, account_id, direction, amount_minor, currency_code, memo)
         VALUES (?, ?, 'DEBIT', ?, ?, 'TD principal in')`
      ).run(principalTxId, settlementAccountId, principalMinor, currency);

      // T2 — gross interest INCOME: settlement destination / interest-income
      // category. Present iff grossInterestMinor > 0; absent iff 0
      // (required-vs-zero component presence, enforced by trigger (9)).
      if (grossInterestMinor > 0) {
        const txInterest = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'INCOME', ?, ?, ?, ?, ?, ?)`
          )
          .run(
            confirmingMemberId,
            currency,
            grossInterestMinor,
            actualSettlementDate,
            "TD gross interest income",
            `settlement-interest:${closureKey}`,
            `doc:${documentId}`
          );
        const interestTxId = Number(txInterest.lastInsertRowid);

        db.prepare(
          `INSERT INTO ledger_entries
             (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', ?, ?, 'Interest credited to settlement')`
        ).run(interestTxId, settlementAccountId, grossInterestMinor, currency);

        const interestCat = db.prepare(`SELECT id FROM categories WHERE slug = 'interest-income'`).get() as {
          id: number;
        };
        db.prepare(
          `INSERT INTO ledger_entries
             (transaction_id, category_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', ?, ?, 'Gross interest offset')`
        ).run(interestTxId, interestCat.id, grossInterestMinor, currency);
      }

      // T3 — withholding tax EXPENSE (only if tax > 0)
      if (includeTax && taxMinor > 0) {
        const txTax = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'EXPENSE', ?, ?, ?, ?, ?, ?)`
          )
          .run(
            confirmingMemberId,
            currency,
            taxMinor,
            actualSettlementDate,
            "Withholding tax on TD interest",
            `settlement-tax:${closureKey}`,
            `doc:${documentId}`
          );
        const taxTxId = Number(txTax.lastInsertRowid);

        db.prepare(
          `INSERT INTO ledger_entries
             (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', ?, ?, 'Tax debited from settlement')`
        ).run(taxTxId, settlementAccountId, taxMinor, currency);

        const taxCat = db.prepare(`SELECT id FROM categories WHERE slug = 'withholding-tax'`).get() as {
          id: number;
        };
        db.prepare(
          `INSERT INTO ledger_entries
             (transaction_id, category_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', ?, ?, 'Tax expense offset')`
        ).run(taxTxId, taxCat.id, taxMinor, currency);
      }

      // T4 — early-termination penalty/fees EXPENSE (only if penalty > 0)
      if (includePenalty && penaltyFeesMinor > 0) {
        const txPen = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'EXPENSE', ?, ?, ?, ?, ?, ?)`
          )
          .run(
            confirmingMemberId,
            currency,
            penaltyFeesMinor,
            actualSettlementDate,
            "Early termination penalty/fees",
            `settlement-penalty:${closureKey}`,
            `doc:${documentId}`
          );
        const penTxId = Number(txPen.lastInsertRowid);

        db.prepare(
          `INSERT INTO ledger_entries
             (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', ?, ?, 'Penalty debited from settlement')`
        ).run(penTxId, settlementAccountId, penaltyFeesMinor, currency);

        const penCat = db.prepare(`SELECT id FROM categories WHERE slug = 'early-termination'`).get() as {
          id: number;
        };
        db.prepare(
          `INSERT INTO ledger_entries
             (transaction_id, category_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', ?, ?, 'Penalty expense offset')`
        ).run(penTxId, penCat.id, penaltyFeesMinor, currency);
      }

      // Optional injected failure: try to insert a ledger_entry that
      // violates the XOR CHECK constraint. Placed here so the trigger
      // hasn't fired yet — the constraint failure should roll back the
      // entire bundle.
      if (injectFailure === "bad_ledger_entry") {
        db.prepare(
          `INSERT INTO ledger_entries
             (transaction_id, account_id, category_id, direction, amount_minor, currency_code)
           VALUES (?, NULL, NULL, 'BAD_DIR', 1, ?)`
        ).run(principalTxId, currency);
      }

      // The closure command. The subquery resolves the canonical
      // principal-transfer transaction id from its deterministic key.
      const closureRes = db
        .prepare(
          `INSERT INTO settlement_closures
             (idempotency_key, review_session_id, deposit_id, document_id,
              confirming_member_id, settlement_account_id, currency_code,
              principal_minor, gross_interest_minor, tax_minor, penalty_fees_minor,
              received_total_minor, actual_settlement_date,
              principal_transfer_transaction_id)
           VALUES (?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?,
                   (SELECT id FROM transactions WHERE idempotency_key = ?))`
        )
        .run(
          closureKey,
          sessionId,
          depositId,
          documentId,
          confirmingMemberId,
          settlementAccountId,
          currency,
          principalMinor,
          grossInterestMinor,
          taxMinor,
          penaltyFeesMinor,
          receivedTotalMinor,
          actualSettlementDate,
          `settlement-principal:${closureKey}`
        );
      return { closureId: Number(closureRes.lastInsertRowid), principalTxId };
    });

    const result = tx();
    return result;
  }

  it("creates settlement_closures table", () => {
    applyMigrations(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settlement_closures'")
      .get();
    expect(row).toBeDefined();
  });

  it("records migration metadata for version 17", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT * FROM migration_metadata WHERE version = 17").get() as
      | { name: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe("0017_settlement_closure_boundary");
  });

  it("adds categories.category_type column with NEITHER default", () => {
    applyMigrations(db);
    const row = db.prepare("SELECT category_type FROM categories WHERE slug = 'groceries'").get() as {
      category_type: string;
    };
    expect(row.category_type).toBe("NEITHER");
  });

  it("seeds the three settlement system categories", () => {
    applyMigrations(db);
    const rows = db
      .prepare(
        "SELECT slug, category_type FROM categories WHERE slug IN ('interest-income','withholding-tax','early-termination')"
      )
      .all() as { slug: string; category_type: string }[];
    expect(rows).toHaveLength(3);
    const byslug = Object.fromEntries(rows.map((r) => [r.slug, r.category_type]));
    expect(byslug["interest-income"]).toBe("INCOME");
    expect(byslug["withholding-tax"]).toBe("EXPENSE");
    expect(byslug["early-termination"]).toBe("EXPENSE");
  });

  it("settlement_closures.idempotency_key is UNIQUE", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture({ sessionKey: "uniq-test" });
    const txPrincipal = db
      .prepare(
        `INSERT INTO transactions (member_id, transaction_type, currency_code, amount_minor, occurred_on, idempotency_key)
         VALUES (?, 'TRANSFER', 'XYZ', 1000000, '2026-04-01', ?)`
      )
      .run(f.ownerMemberId, "settlement-principal:uniq-test");
    const principalTxId = Number(txPrincipal.lastInsertRowid);

    db.prepare(
      `INSERT INTO ledger_entries
         (transaction_id, account_id, direction, amount_minor, currency_code, memo)
       VALUES (?, ?, 'CREDIT', ?, 'XYZ', 'TD principal out')`
    ).run(principalTxId, f.tdAccountId, 1000000);
    db.prepare(
      `INSERT INTO ledger_entries
         (transaction_id, account_id, direction, amount_minor, currency_code, memo)
       VALUES (?, ?, 'DEBIT', ?, 'XYZ', 'TD principal in')`
    ).run(principalTxId, f.settlementAccountId, 1000000);

    db.prepare(
      `INSERT INTO settlement_closures
         (idempotency_key, review_session_id, deposit_id, document_id,
          confirming_member_id, settlement_account_id, currency_code,
          principal_minor, gross_interest_minor, tax_minor, penalty_fees_minor,
          received_total_minor, actual_settlement_date,
          principal_transfer_transaction_id)
       VALUES (?, ?, ?, ?, ?, ?, 'XYZ',
               1000000, 0, 0, 0, 1000000, '2026-04-01',
               ?)`
    ).run(
      "uniq-test",
      f.sessionId,
      f.depositId,
      f.documentId,
      f.ownerMemberId,
      f.settlementAccountId,
      principalTxId
    );

    expect(() => {
      db.prepare(
        `INSERT INTO settlement_closures
           (idempotency_key, review_session_id, deposit_id, document_id,
            confirming_member_id, settlement_account_id, currency_code,
            principal_minor, gross_interest_minor, tax_minor, penalty_fees_minor,
            received_total_minor, actual_settlement_date,
            principal_transfer_transaction_id)
         VALUES (?, ?, ?, ?, ?, ?, 'XYZ',
                 1000000, 0, 0, 0, 1000000, '2026-04-01',
                 ?)`
      ).run(
        "uniq-test",
        f.sessionId,
        f.depositId,
        f.documentId,
        f.ownerMemberId,
        f.settlementAccountId,
        principalTxId
      );
    }).toThrow();
  });

  it("canonical closure succeeds and writes the complete balanced bundle", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    // principal=1,000,000; gross_interest=80,000; tax=10,000; penalty=0;
    // received=1,070,000  (1,000,000 + 80,000 - 10,000 - 0)
    const principal = 1000000;
    const grossInterest = 80000;
    const tax = 10000;
    const penaltyFees = 0;
    const received = principal + grossInterest - tax - penaltyFees;
    const result = performSettlementClosure({
      db,
      sessionId: f.sessionId,
      depositId: f.depositId,
      depositSourceAccountId: f.tdAccountId,
      documentId: f.documentId,
      confirmingMemberId: f.ownerMemberId,
      settlementAccountId: f.settlementAccountId,
      currency: f.currency,
      principalMinor: principal,
      grossInterestMinor: grossInterest,
      taxMinor: tax,
      penaltyFeesMinor: penaltyFees,
      receivedTotalMinor: received,
      actualSettlementDate: "2026-04-01",
      closureKey: f.closureKey,
      includeTax: true,
      includePenalty: false,
    });

    // settlement_closures row
    const closure = db
      .prepare("SELECT * FROM settlement_closures WHERE id = ?")
      .get(result.closureId) as Record<string, unknown>;
    expect(closure).toBeDefined();
    expect(closure.idempotency_key).toBe(f.closureKey);
    expect(closure.review_session_id).toBe(f.sessionId);
    expect(closure.deposit_id).toBe(f.depositId);
    expect(closure.document_id).toBe(f.documentId);
    expect(closure.confirming_member_id).toBe(f.ownerMemberId);
    expect(closure.settlement_account_id).toBe(f.settlementAccountId);
    expect(closure.principal_minor).toBe(principal);
    expect(closure.gross_interest_minor).toBe(grossInterest);
    expect(closure.tax_minor).toBe(tax);
    expect(closure.penalty_fees_minor).toBe(penaltyFees);
    expect(closure.received_total_minor).toBe(received);
    expect(closure.principal_transfer_transaction_id).toBe(result.principalTxId);

    // 3 transactions: principal TRANSFER, interest INCOME, tax EXPENSE
    const txCount = (db.prepare("SELECT COUNT(*) as cnt FROM transactions").get() as { cnt: number }).cnt;
    expect(txCount).toBe(3);

    // Each transaction balances in its currency: sum(Direction) == 0
    const imbalances = db
      .prepare(
        `SELECT transaction_id,
                SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END) as net
         FROM ledger_entries
         GROUP BY transaction_id
         HAVING net <> 0`
      )
      .all() as { transaction_id: number; net: number }[];
    expect(imbalances).toEqual([]);

    // Deposit is finalized
    const deposit = db
      .prepare(
        "SELECT state, settlement_evidence_ref, maturity_settlement_account_id, settlement_closure_id FROM term_deposits WHERE id = ?"
      )
      .get(f.depositId) as Record<string, unknown>;
    expect(deposit.state).toBe("SETTLED_TO_ACCOUNT");
    expect(deposit.settlement_evidence_ref).toBe(`doc:${f.documentId}`);
    expect(deposit.maturity_settlement_account_id).toBe(f.settlementAccountId);
    expect(deposit.settlement_closure_id).toBe(result.closureId);

    // Review session is confirmed + linked to the canonical principal transfer
    const session = db
      .prepare("SELECT status, linked_transaction_id FROM review_sessions WHERE id = ?")
      .get(f.sessionId) as Record<string, unknown>;
    expect(session.status).toBe("CONFIRMED");
    expect(session.linked_transaction_id).toBe(result.principalTxId);

    // Net settlement-account change equals received_total
    const settlementNet = (
      db
        .prepare(
          `SELECT SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END) as net
           FROM ledger_entries WHERE account_id = ?`
        )
        .get(f.settlementAccountId) as { net: number }
    ).net;
    expect(settlementNet).toBe(received);

    // Net source TD-account change equals -principal
    const sourceNet = (
      db
        .prepare(
          `SELECT SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END) as net
           FROM ledger_entries WHERE account_id = ?`
        )
        .get(f.tdAccountId) as { net: number }
    ).net;
    expect(sourceNet).toBe(-principal);
  });

  it("same-key retry is canonical: zero duplicate mutation", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    const principal = 1000000;
    const grossInterest = 80000;
    const tax = 10000;
    const received = principal + grossInterest - tax;
    const first = performSettlementClosure({
      db,
      sessionId: f.sessionId,
      depositId: f.depositId,
      depositSourceAccountId: f.tdAccountId,
      documentId: f.documentId,
      confirmingMemberId: f.ownerMemberId,
      settlementAccountId: f.settlementAccountId,
      currency: f.currency,
      principalMinor: principal,
      grossInterestMinor: grossInterest,
      taxMinor: tax,
      penaltyFeesMinor: 0,
      receivedTotalMinor: received,
      actualSettlementDate: "2026-04-01",
      closureKey: f.closureKey,
      includeTax: true,
    });

    // Snapshot the canonical state
    const closuresBefore = (
      db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }
    ).cnt;
    const txsBefore = (db.prepare("SELECT COUNT(*) as cnt FROM transactions").get() as { cnt: number }).cnt;
    const depositStateBefore = (
      db.prepare("SELECT state FROM term_deposits WHERE id = ?").get(f.depositId) as {
        state: string;
      }
    ).state;

    // Second attempt with the SAME key collides on transactions
    // .idempotency_key UNIQUE and the entire batch rolls back.
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: principal,
        grossInterestMinor: grossInterest,
        taxMinor: tax,
        penaltyFeesMinor: 0,
        receivedTotalMinor: received,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
        includeTax: true,
      });
    }).toThrow();

    // Canonical row count unchanged
    expect((db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }).cnt).toBe(
      closuresBefore
    );
    expect((db.prepare("SELECT COUNT(*) as cnt FROM transactions").get() as { cnt: number }).cnt).toBe(
      txsBefore
    );
    expect(
      (
        db.prepare("SELECT state FROM term_deposits WHERE id = ?").get(f.depositId) as {
          state: string;
        }
      ).state
    ).toBe(depositStateBefore);
    // First closure row is still the same id (no duplicate)
    expect(first.closureId).toBeDefined();
  });

  it("different-key retry against an already-confirmed session is blocked", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    performSettlementClosure({
      db,
      sessionId: f.sessionId,
      depositId: f.depositId,
      depositSourceAccountId: f.tdAccountId,
      documentId: f.documentId,
      confirmingMemberId: f.ownerMemberId,
      settlementAccountId: f.settlementAccountId,
      currency: f.currency,
      principalMinor: 1000000,
      grossInterestMinor: 80000,
      taxMinor: 10000,
      penaltyFeesMinor: 0,
      receivedTotalMinor: 1070000,
      actualSettlementDate: "2026-04-01",
      closureKey: f.closureKey,
      includeTax: true,
    });

    // Session is now CONFIRMED. A second attempt with a different key
    // must fail because the session is no longer PENDING_REVIEW.
    const differentKey = `${f.closureKey}-other`;
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 80000,
        taxMinor: 10000,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1070000,
        actualSettlementDate: "2026-04-01",
        closureKey: differentKey,
        includeTax: true,
      });
    }).toThrow();

    // Canonical closure from first attempt is still the only one.
    expect((db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }).cnt).toBe(
      1
    );
    expect((db.prepare("SELECT COUNT(*) as cnt FROM transactions").get() as { cnt: number }).cnt).toBe(3);
    const sessionStatus = (
      db.prepare("SELECT status FROM review_sessions WHERE id = ?").get(f.sessionId) as {
        status: string;
      }
    ).status;
    expect(sessionStatus).toBe("CONFIRMED");
  });

  it("wrong post_idempotency_key against the session is blocked", () => {
    applyMigrations(db);
    // sessionKey is fixed; closureKey differs → mismatch.
    const f = seedSettlementClosureFixture({ sessionKey: "session-key-A" });
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: "different-key-B",
      });
    }).toThrow();
    expect((db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }).cnt).toBe(
      0
    );
  });

  it("wrong deposit state (not MATURED_ACTION_REQUIRED) is blocked", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture({ depositState: "ACTIVE" });
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
      });
    }).toThrow();
    expect((db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }).cnt).toBe(
      0
    );
    expect((db.prepare("SELECT COUNT(*) as cnt FROM transactions").get() as { cnt: number }).cnt).toBe(0);
  });

  it("wrong role (MEMBER not OWNER) is blocked", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture({ confirmingMemberRole: "MEMBER" });
    // Re-point session at the MEMBER so the OWNER check sees a MEMBER.
    db.prepare("UPDATE review_sessions SET confirming_member_id = ? WHERE id = ?").run(
      f.otherMemberId,
      f.sessionId
    );
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.otherMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
      });
    }).toThrow();
    expect((db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }).cnt).toBe(
      0
    );
    expect((db.prepare("SELECT COUNT(*) as cnt FROM transactions").get() as { cnt: number }).cnt).toBe(0);
  });

  it("inactive confirming member is blocked", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture({ confirmingMemberActive: 0 });
    // Re-point session at the inactive OWNER member.
    db.prepare(
      "UPDATE review_sessions SET confirming_member_id = ?, post_idempotency_key = ? WHERE id = ?"
    ).run(f.otherMemberId, f.closureKey, f.sessionId);
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.otherMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
      });
    }).toThrow();
    expect((db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }).cnt).toBe(
      0
    );
  });

  it("currency mismatch between source and destination is blocked", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture({ settlementCurrency: "ZYX" });
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency, // XYZ (matches TD account, NOT destination)
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
      });
    }).toThrow();
    expect((db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }).cnt).toBe(
      0
    );
  });

  it("reconciliation mismatch is blocked", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 80000,
        taxMinor: 10000,
        penaltyFeesMinor: 0,
        // Wrong: 1,070,000 should equal 1,000,000+80,000-10,000-0 = 1,070,000
        // but we lie and say received = 1,000,000 (skimming interest).
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
        includeTax: true,
      });
    }).toThrow();
    expect((db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }).cnt).toBe(
      0
    );
  });

  it("archived settlement account is blocked", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture({ settlementArchived: 1 });
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
      });
    }).toThrow();
    expect((db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }).cnt).toBe(
      0
    );
  });

  it("wrong document kind is blocked", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture({ documentKind: "RECEIPT" });
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
      });
    }).toThrow();
    expect((db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }).cnt).toBe(
      0
    );
  });

  it("injected ledger-constraint failure rolls back the entire bundle", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
        injectFailure: "bad_ledger_entry",
      });
    }).toThrow();
    // Zero partial mutation: nothing committed.
    expect((db.prepare("SELECT COUNT(*) as cnt FROM settlement_closures").get() as { cnt: number }).cnt).toBe(
      0
    );
    expect((db.prepare("SELECT COUNT(*) as cnt FROM transactions").get() as { cnt: number }).cnt).toBe(0);
    expect((db.prepare("SELECT COUNT(*) as cnt FROM ledger_entries").get() as { cnt: number }).cnt).toBe(0);
    // Deposit and session untouched.
    expect(
      (
        db.prepare("SELECT state FROM term_deposits WHERE id = ?").get(f.depositId) as {
          state: string;
        }
      ).state
    ).toBe("MATURED_ACTION_REQUIRED");
    expect(
      (
        db.prepare("SELECT status FROM review_sessions WHERE id = ?").get(f.sessionId) as {
          status: string;
        }
      ).status
    ).toBe("PENDING_REVIEW");
  });

  it("closure with non-zero tax and penalty writes the full 4-transaction bundle", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    // principal=1,000,000; gross_interest=100,000; tax=20,000; penalty=10,000;
    // received=1,070,000
    const principal = 1000000;
    const grossInterest = 100000;
    const tax = 20000;
    const penaltyFees = 10000;
    const received = principal + grossInterest - tax - penaltyFees;
    performSettlementClosure({
      db,
      sessionId: f.sessionId,
      depositId: f.depositId,
      depositSourceAccountId: f.tdAccountId,
      documentId: f.documentId,
      confirmingMemberId: f.ownerMemberId,
      settlementAccountId: f.settlementAccountId,
      currency: f.currency,
      principalMinor: principal,
      grossInterestMinor: grossInterest,
      taxMinor: tax,
      penaltyFeesMinor: penaltyFees,
      receivedTotalMinor: received,
      actualSettlementDate: "2026-04-01",
      closureKey: f.closureKey,
      includeTax: true,
      includePenalty: true,
    });

    // 4 transactions: principal TRANSFER, interest INCOME, tax EXPENSE, penalty EXPENSE
    expect((db.prepare("SELECT COUNT(*) as cnt FROM transactions").get() as { cnt: number }).cnt).toBe(4);

    const imbalances = db
      .prepare(
        `SELECT transaction_id,
                SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END) as net
         FROM ledger_entries
         GROUP BY transaction_id
         HAVING net <> 0`
      )
      .all() as { transaction_id: number; net: number }[];
    expect(imbalances).toEqual([]);

    const settlementNet = (
      db
        .prepare(
          `SELECT SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END) as net
           FROM ledger_entries WHERE account_id = ?`
        )
        .get(f.settlementAccountId) as { net: number }
    ).net;
    expect(settlementNet).toBe(received);
  });

  // ── M3C SETTLEMENT A1 — ledger-binding micro-repair negative tests ───────
  // These tests exercise the six verified semantic findings from review
  // 5135450533: each must abort the closure INSERT with zero partial
  // mutation (count of settlement_closures = 0; count of transactions = 0).

  function rowCount(sql: string): number {
    const r = db.prepare(sql).get() as { cnt: number };
    return r.cnt;
  }

  it("closure document_id not bound to review session is blocked (Finding 1)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    // Insert a SECOND SETTLEMENT_EVIDENCE document — the closure will
    // reference this one instead of the session's bound document.
    const otherDoc = db
      .prepare(
        `INSERT INTO documents
           (kind, owner_member_id, uploader_member_id, content_type, byte_size, sha256_hex, object_key)
         VALUES ('SETTLEMENT_EVIDENCE', ?, ?, 'image/png', 1024,
                 '1111111111111111111111111111111111111111111111111111111111111111',
                 'docs/other/' || ?)`
      )
      .run(f.ownerMemberId, f.ownerMemberId, `doc-other-${Date.now()}-${Math.random()}`);
    const otherDocumentId = Number(otherDoc.lastInsertRowid);
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: otherDocumentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
      });
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(0);
    expect(rowCount("SELECT COUNT(*) as cnt FROM transactions")).toBe(0);
  });

  it("closure principal_minor not equal to deposit.principal_minor is blocked (Finding 2)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 999999, // deposit.principal_minor is 1,000,000
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 999999,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
      });
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(0);
    expect(rowCount("SELECT COUNT(*) as cnt FROM transactions")).toBe(0);
  });

  it("closure currency_code not equal to deposit.currency_code is blocked (Finding 2)", () => {
    applyMigrations(db);
    // TD account and settlement account are XYZ; deposit.currency_code is ZYX.
    // The closure's currency (XYZ) matches accounts, so precondition (5) passes
    // — the mismatch with the deposit's recorded currency must fire (2).
    const f = seedSettlementClosureFixture({ depositCurrency: "ZYX" });
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency, // XYZ
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: f.closureKey,
      });
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(0);
    expect(rowCount("SELECT COUNT(*) as cnt FROM transactions")).toBe(0);
  });

  it("non-ISO actual_settlement_date is blocked at the CHECK constraint (Finding 4)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "04/01/2026", // not ISO YYYY-MM-DD
        closureKey: f.closureKey,
      });
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(0);
    expect(rowCount("SELECT COUNT(*) as cnt FROM transactions")).toBe(0);
  });

  it("settlement_closures has UNIQUE index on review_session_id (Finding 5)", () => {
    applyMigrations(db);
    const idx = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_settlement_closures_session'")
      .get() as { sql: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx!.sql).toMatch(/\bUNIQUE\b/i);
  });

  it("settlement_closures has UNIQUE index on deposit_id (Finding 5)", () => {
    applyMigrations(db);
    const idx = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_settlement_closures_deposit'")
      .get() as { sql: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx!.sql).toMatch(/\bUNIQUE\b/i);
  });

  it("term_deposits has UNIQUE index on settlement_closure_id (Finding 5)", () => {
    applyMigrations(db);
    const idx = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_term_deposits_settlement_closure_id'"
      )
      .get() as { sql: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx!.sql).toMatch(/\bUNIQUE\b/i);
  });

  it("duplicate closure for the same review_session_id is blocked by UNIQUE (Finding 5)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    // First closure succeeds: session CONFIRMED, deposit SETTLED_TO_ACCOUNT.
    performSettlementClosure({
      db,
      sessionId: f.sessionId,
      depositId: f.depositId,
      depositSourceAccountId: f.tdAccountId,
      documentId: f.documentId,
      confirmingMemberId: f.ownerMemberId,
      settlementAccountId: f.settlementAccountId,
      currency: f.currency,
      principalMinor: 1000000,
      grossInterestMinor: 0,
      taxMinor: 0,
      penaltyFeesMinor: 0,
      receivedTotalMinor: 1000000,
      actualSettlementDate: "2026-04-01",
      closureKey: f.closureKey,
    });
    // Reset session/deposit state to bypass state preconditions. The UNIQUE
    // index on review_session_id is the defense-in-depth backstop.
    const dupKey = `${f.closureKey}-dup-session`;
    db.prepare(
      "UPDATE review_sessions SET status = 'PENDING_REVIEW', linked_transaction_id = NULL, post_idempotency_key = ? WHERE id = ?"
    ).run(dupKey, f.sessionId);
    db.prepare(
      "UPDATE term_deposits SET state = 'MATURED_ACTION_REQUIRED', settlement_evidence_ref = NULL, maturity_settlement_account_id = NULL, settlement_closure_id = NULL WHERE id = ?"
    ).run(f.depositId);
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: f.sessionId,
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: dupKey,
      });
    }).toThrow();
    // Only the canonical row remains; second attempt was rejected by UNIQUE.
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(1);
  });

  it("duplicate closure for the same deposit_id is blocked by UNIQUE (Finding 5)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    performSettlementClosure({
      db,
      sessionId: f.sessionId,
      depositId: f.depositId,
      depositSourceAccountId: f.tdAccountId,
      documentId: f.documentId,
      confirmingMemberId: f.ownerMemberId,
      settlementAccountId: f.settlementAccountId,
      currency: f.currency,
      principalMinor: 1000000,
      grossInterestMinor: 0,
      taxMinor: 0,
      penaltyFeesMinor: 0,
      receivedTotalMinor: 1000000,
      actualSettlementDate: "2026-04-01",
      closureKey: f.closureKey,
    });
    // Create a SECOND SETTLEMENT review session for the SAME deposit, then
    // reset deposit state to bypass the state-precondition. The UNIQUE
    // index on deposit_id is the backstop that must fire.
    const dupKey = `${f.closureKey}-dup-deposit`;
    const session2 = db
      .prepare(
        `INSERT INTO review_sessions
           (kind, status, document_id, deposit_id, confirming_member_id,
            review_decision_json, candidate_payload_json, corrected_payload_json,
            post_idempotency_key)
         VALUES ('SETTLEMENT', 'PENDING_REVIEW', ?, ?, ?, '{}', '{}', '{}', ?)`
      )
      .run(f.documentId, f.depositId, f.ownerMemberId, dupKey);
    db.prepare(
      "UPDATE term_deposits SET state = 'MATURED_ACTION_REQUIRED', settlement_evidence_ref = NULL, maturity_settlement_account_id = NULL, settlement_closure_id = NULL WHERE id = ?"
    ).run(f.depositId);
    expect(() => {
      performSettlementClosure({
        db,
        sessionId: Number(session2.lastInsertRowid),
        depositId: f.depositId,
        depositSourceAccountId: f.tdAccountId,
        documentId: f.documentId,
        confirmingMemberId: f.ownerMemberId,
        settlementAccountId: f.settlementAccountId,
        currency: f.currency,
        principalMinor: 1000000,
        grossInterestMinor: 0,
        taxMinor: 0,
        penaltyFeesMinor: 0,
        receivedTotalMinor: 1000000,
        actualSettlementDate: "2026-04-01",
        closureKey: dupKey,
      });
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(1);
  });

  it("omitted principal TRANSFER bundle aborts closure with zero mutation (Finding 3 omitted)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    // Write NO ledger entries, then INSERT the closure row with a sentinel
    // (0) for principal_transfer_transaction_id. The BEFORE trigger (8)
    // requires a real TRANSFER bundle to exist for the closure key.
    expect(() => {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO settlement_closures
             (idempotency_key, review_session_id, deposit_id, document_id,
              confirming_member_id, settlement_account_id, currency_code,
              principal_minor, gross_interest_minor, tax_minor, penalty_fees_minor,
              received_total_minor, actual_settlement_date,
              principal_transfer_transaction_id)
           VALUES (?, ?, ?, ?, ?, ?, ?,
                   ?, 0, 0, 0, ?, '2026-04-01',
                   0)`
        ).run(
          f.closureKey,
          f.sessionId,
          f.depositId,
          f.documentId,
          f.ownerMemberId,
          f.settlementAccountId,
          f.currency,
          1000000,
          1000000
        );
      })();
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(0);
    expect(rowCount("SELECT COUNT(*) as cnt FROM transactions")).toBe(0);
  });

  it("substituted principal TRANSFER with wrong amount aborts closure with zero mutation (Finding 3 substituted)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    const principalClaimed = 1000000;
    const principalBooked = 999999; // off by 1 minor unit
    expect(() => {
      db.transaction(() => {
        const txPrincipal = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'TRANSFER', ?, ?, '2026-04-01', ?, ?, ?)`
          )
          .run(
            f.ownerMemberId,
            f.currency,
            principalBooked,
            "TD principal transfer",
            `settlement-principal:${f.closureKey}`,
            `doc:${f.documentId}`
          );
        const principalTxId = Number(txPrincipal.lastInsertRowid);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', ?, ?, 'TD principal out')`
        ).run(principalTxId, f.tdAccountId, principalBooked, f.currency);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', ?, ?, 'TD principal in')`
        ).run(principalTxId, f.settlementAccountId, principalBooked, f.currency);

        db.prepare(
          `INSERT INTO settlement_closures
             (idempotency_key, review_session_id, deposit_id, document_id,
              confirming_member_id, settlement_account_id, currency_code,
              principal_minor, gross_interest_minor, tax_minor, penalty_fees_minor,
              received_total_minor, actual_settlement_date,
              principal_transfer_transaction_id)
           VALUES (?, ?, ?, ?, ?, ?, ?,
                   ?, 0, 0, 0, ?, '2026-04-01',
                   ?)`
        ).run(
          f.closureKey,
          f.sessionId,
          f.depositId,
          f.documentId,
          f.ownerMemberId,
          f.settlementAccountId,
          f.currency,
          principalClaimed,
          principalClaimed,
          principalTxId
        );
      })();
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(0);
    expect(rowCount("SELECT COUNT(*) as cnt FROM transactions")).toBe(0);
  });

  it("malformed interest bundle (wrong category) aborts closure with zero mutation (Finding 3 malformed)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    const principal = 1000000;
    const grossInterest = 80000;
    const received = principal + grossInterest;
    expect(() => {
      db.transaction(() => {
        const txPrincipal = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'TRANSFER', ?, ?, '2026-04-01', ?, ?, ?)`
          )
          .run(
            f.ownerMemberId,
            f.currency,
            principal,
            "TD principal transfer",
            `settlement-principal:${f.closureKey}`,
            `doc:${f.documentId}`
          );
        const principalTxId = Number(txPrincipal.lastInsertRowid);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', ?, ?, 'TD principal out')`
        ).run(principalTxId, f.tdAccountId, principal, f.currency);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', ?, ?, 'TD principal in')`
        ).run(principalTxId, f.settlementAccountId, principal, f.currency);

        // Malformed interest TX: type and amount are right but the category
        // is wrong (withholding-tax instead of interest-income).
        const txInterest = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'INCOME', ?, ?, '2026-04-01', ?, ?, ?)`
          )
          .run(
            f.ownerMemberId,
            f.currency,
            grossInterest,
            "TD gross interest income",
            `settlement-interest:${f.closureKey}`,
            `doc:${f.documentId}`
          );
        const interestTxId = Number(txInterest.lastInsertRowid);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', ?, ?, 'Interest credited')`
        ).run(interestTxId, f.settlementAccountId, grossInterest, f.currency);
        const wrongCat = db.prepare(`SELECT id FROM categories WHERE slug = 'withholding-tax'`).get() as {
          id: number;
        };
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, category_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', ?, ?, 'Wrong-category credit')`
        ).run(interestTxId, wrongCat.id, grossInterest, f.currency);

        db.prepare(
          `INSERT INTO settlement_closures
             (idempotency_key, review_session_id, deposit_id, document_id,
              confirming_member_id, settlement_account_id, currency_code,
              principal_minor, gross_interest_minor, tax_minor, penalty_fees_minor,
              received_total_minor, actual_settlement_date,
              principal_transfer_transaction_id)
           VALUES (?, ?, ?, ?, ?, ?, ?,
                   ?, ?, 0, 0, ?, '2026-04-01',
                   ?)`
        ).run(
          f.closureKey,
          f.sessionId,
          f.depositId,
          f.documentId,
          f.ownerMemberId,
          f.settlementAccountId,
          f.currency,
          principal,
          grossInterest,
          received,
          principalTxId
        );
      })();
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(0);
    expect(rowCount("SELECT COUNT(*) as cnt FROM transactions")).toBe(0);
  });

  it("omitted interest bundle when gross_interest > 0 aborts with zero mutation (Finding 6 required-vs-zero)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    const principal = 1000000;
    const grossInterest = 80000;
    const tax = 10000;
    const received = principal + grossInterest - tax;
    expect(() => {
      db.transaction(() => {
        const txPrincipal = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'TRANSFER', ?, ?, '2026-04-01', ?, ?, ?)`
          )
          .run(
            f.ownerMemberId,
            f.currency,
            principal,
            "TD principal transfer",
            `settlement-principal:${f.closureKey}`,
            `doc:${f.documentId}`
          );
        const principalTxId = Number(txPrincipal.lastInsertRowid);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', ?, ?, 'TD principal out')`
        ).run(principalTxId, f.tdAccountId, principal, f.currency);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', ?, ?, 'TD principal in')`
        ).run(principalTxId, f.settlementAccountId, principal, f.currency);

        const txTax = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'EXPENSE', ?, ?, '2026-04-01', ?, ?, ?)`
          )
          .run(
            f.ownerMemberId,
            f.currency,
            tax,
            "Withholding tax on interest",
            `settlement-tax:${f.closureKey}`,
            `doc:${f.documentId}`
          );
        const taxTxId = Number(txTax.lastInsertRowid);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', ?, ?, 'Tax debited')`
        ).run(taxTxId, f.settlementAccountId, tax, f.currency);
        const taxCat = db.prepare(`SELECT id FROM categories WHERE slug = 'withholding-tax'`).get() as {
          id: number;
        };
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, category_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', ?, ?, 'Tax expense offset')`
        ).run(taxTxId, taxCat.id, tax, f.currency);

        // Omit the interest bundle — claim gross_interest_minor = 80_000 but
        // never write the INCOME transaction.
        db.prepare(
          `INSERT INTO settlement_closures
             (idempotency_key, review_session_id, deposit_id, document_id,
              confirming_member_id, settlement_account_id, currency_code,
              principal_minor, gross_interest_minor, tax_minor, penalty_fees_minor,
              received_total_minor, actual_settlement_date,
              principal_transfer_transaction_id)
           VALUES (?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, 0, ?, '2026-04-01',
                   ?)`
        ).run(
          f.closureKey,
          f.sessionId,
          f.depositId,
          f.documentId,
          f.ownerMemberId,
          f.settlementAccountId,
          f.currency,
          principal,
          grossInterest,
          tax,
          received,
          principalTxId
        );
      })();
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(0);
    expect(rowCount("SELECT COUNT(*) as cnt FROM transactions")).toBe(0);
  });

  it("interest bundle present when gross_interest == 0 aborts with zero mutation (Finding 6 required-vs-zero)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    const principal = 1000000;
    expect(() => {
      db.transaction(() => {
        const txPrincipal = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'TRANSFER', ?, ?, '2026-04-01', ?, ?, ?)`
          )
          .run(
            f.ownerMemberId,
            f.currency,
            principal,
            "TD principal transfer",
            `settlement-principal:${f.closureKey}`,
            `doc:${f.documentId}`
          );
        const principalTxId = Number(txPrincipal.lastInsertRowid);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', ?, ?, 'TD principal out')`
        ).run(principalTxId, f.tdAccountId, principal, f.currency);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', ?, ?, 'TD principal in')`
        ).run(principalTxId, f.settlementAccountId, principal, f.currency);

        // Spurious interest TX that must NOT exist when gross_interest = 0.
        const txInterest = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'INCOME', ?, 1, '2026-04-01', ?, ?, ?)`
          )
          .run(
            f.ownerMemberId,
            f.currency,
            "Spurious interest",
            `settlement-interest:${f.closureKey}`,
            `doc:${f.documentId}`
          );
        const interestTxId = Number(txInterest.lastInsertRowid);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', 1, ?, 'Spurious interest in')`
        ).run(interestTxId, f.settlementAccountId, f.currency);
        const interestCat = db.prepare(`SELECT id FROM categories WHERE slug = 'interest-income'`).get() as {
          id: number;
        };
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, category_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', 1, ?, 'Spurious interest offset')`
        ).run(interestTxId, interestCat.id, f.currency);

        db.prepare(
          `INSERT INTO settlement_closures
             (idempotency_key, review_session_id, deposit_id, document_id,
              confirming_member_id, settlement_account_id, currency_code,
              principal_minor, gross_interest_minor, tax_minor, penalty_fees_minor,
              received_total_minor, actual_settlement_date,
              principal_transfer_transaction_id)
           VALUES (?, ?, ?, ?, ?, ?, ?,
                   ?, 0, 0, 0, ?, '2026-04-01',
                   ?)`
        ).run(
          f.closureKey,
          f.sessionId,
          f.depositId,
          f.documentId,
          f.ownerMemberId,
          f.settlementAccountId,
          f.currency,
          principal,
          principal,
          principalTxId
        );
      })();
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(0);
    expect(rowCount("SELECT COUNT(*) as cnt FROM transactions")).toBe(0);
  });

  it("tax bundle present when tax_minor == 0 aborts with zero mutation (Finding 6 required-vs-zero)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    const principal = 1000000;
    expect(() => {
      db.transaction(() => {
        const txPrincipal = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'TRANSFER', ?, ?, '2026-04-01', ?, ?, ?)`
          )
          .run(
            f.ownerMemberId,
            f.currency,
            principal,
            "TD principal transfer",
            `settlement-principal:${f.closureKey}`,
            `doc:${f.documentId}`
          );
        const principalTxId = Number(txPrincipal.lastInsertRowid);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', ?, ?, 'TD principal out')`
        ).run(principalTxId, f.tdAccountId, principal, f.currency);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', ?, ?, 'TD principal in')`
        ).run(principalTxId, f.settlementAccountId, principal, f.currency);

        // Spurious tax TX that must NOT exist when tax_minor = 0.
        const txTax = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'EXPENSE', ?, 1, '2026-04-01', ?, ?, ?)`
          )
          .run(
            f.ownerMemberId,
            f.currency,
            "Spurious tax",
            `settlement-tax:${f.closureKey}`,
            `doc:${f.documentId}`
          );
        const taxTxId = Number(txTax.lastInsertRowid);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', 1, ?, 'Spurious tax out')`
        ).run(taxTxId, f.settlementAccountId, f.currency);
        const taxCat = db.prepare(`SELECT id FROM categories WHERE slug = 'withholding-tax'`).get() as {
          id: number;
        };
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, category_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', 1, ?, 'Spurious tax offset')`
        ).run(taxTxId, taxCat.id, f.currency);

        db.prepare(
          `INSERT INTO settlement_closures
             (idempotency_key, review_session_id, deposit_id, document_id,
              confirming_member_id, settlement_account_id, currency_code,
              principal_minor, gross_interest_minor, tax_minor, penalty_fees_minor,
              received_total_minor, actual_settlement_date,
              principal_transfer_transaction_id)
           VALUES (?, ?, ?, ?, ?, ?, ?,
                   ?, 0, 0, 0, ?, '2026-04-01',
                   ?)`
        ).run(
          f.closureKey,
          f.sessionId,
          f.depositId,
          f.documentId,
          f.ownerMemberId,
          f.settlementAccountId,
          f.currency,
          principal,
          principal,
          principalTxId
        );
      })();
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(0);
    expect(rowCount("SELECT COUNT(*) as cnt FROM transactions")).toBe(0);
  });

  it("penalty bundle present when penalty_fees_minor == 0 aborts with zero mutation (Finding 6 required-vs-zero)", () => {
    applyMigrations(db);
    const f = seedSettlementClosureFixture();
    const principal = 1000000;
    expect(() => {
      db.transaction(() => {
        const txPrincipal = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'TRANSFER', ?, ?, '2026-04-01', ?, ?, ?)`
          )
          .run(
            f.ownerMemberId,
            f.currency,
            principal,
            "TD principal transfer",
            `settlement-principal:${f.closureKey}`,
            `doc:${f.documentId}`
          );
        const principalTxId = Number(txPrincipal.lastInsertRowid);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', ?, ?, 'TD principal out')`
        ).run(principalTxId, f.tdAccountId, principal, f.currency);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', ?, ?, 'TD principal in')`
        ).run(principalTxId, f.settlementAccountId, principal, f.currency);

        // Spurious penalty TX that must NOT exist when penalty_fees_minor = 0.
        const txPen = db
          .prepare(
            `INSERT INTO transactions
               (member_id, transaction_type, currency_code, amount_minor,
                occurred_on, description, idempotency_key, source_evidence_ref)
             VALUES (?, 'EXPENSE', ?, 1, '2026-04-01', ?, ?, ?)`
          )
          .run(
            f.ownerMemberId,
            f.currency,
            "Spurious penalty",
            `settlement-penalty:${f.closureKey}`,
            `doc:${f.documentId}`
          );
        const penTxId = Number(txPen.lastInsertRowid);
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'CREDIT', 1, ?, 'Spurious penalty out')`
        ).run(penTxId, f.settlementAccountId, f.currency);
        const penCat = db.prepare(`SELECT id FROM categories WHERE slug = 'early-termination'`).get() as {
          id: number;
        };
        db.prepare(
          `INSERT INTO ledger_entries (transaction_id, category_id, direction, amount_minor, currency_code, memo)
           VALUES (?, ?, 'DEBIT', 1, ?, 'Spurious penalty offset')`
        ).run(penTxId, penCat.id, f.currency);

        db.prepare(
          `INSERT INTO settlement_closures
             (idempotency_key, review_session_id, deposit_id, document_id,
              confirming_member_id, settlement_account_id, currency_code,
              principal_minor, gross_interest_minor, tax_minor, penalty_fees_minor,
              received_total_minor, actual_settlement_date,
              principal_transfer_transaction_id)
           VALUES (?, ?, ?, ?, ?, ?, ?,
                   ?, 0, 0, 0, ?, '2026-04-01',
                   ?)`
        ).run(
          f.closureKey,
          f.sessionId,
          f.depositId,
          f.documentId,
          f.ownerMemberId,
          f.settlementAccountId,
          f.currency,
          principal,
          principal,
          principalTxId
        );
      })();
    }).toThrow();
    expect(rowCount("SELECT COUNT(*) as cnt FROM settlement_closures")).toBe(0);
    expect(rowCount("SELECT COUNT(*) as cnt FROM transactions")).toBe(0);
  });
});
