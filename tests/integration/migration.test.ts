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
});
