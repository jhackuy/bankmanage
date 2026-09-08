/**
 * tests/unit/migrate-apply.test.ts
 *
 * Verifies the M5 forward-migration planner:
 *   - deterministic lex-ordered migration enumeration;
 *   - inert by default (commandPlan stays in `--list` shape);
 *   - apply intent requires BOTH a token and an explicit apply flag;
 *   - never echoes secret-shaped values;
 *   - empty migrations directory is a hard error (not a silent no-op);
 *   - CLI mode prints names only and reports migration counts.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { listForwardMigrations, planManagedD1Apply } from "../../scripts/migrate-apply.mjs";

const SCRIPT = join(process.cwd(), "scripts", "migrate-apply.mjs");

const VALID_ENV = {
  CLOUDFLARE_ACCOUNT_ID: "abcd1234abcd1234abcd1234abcd1234",
  CLOUDFLARE_D1_DATABASE_ID: "123e4567-e89b-42d3-a456-426614174000",
};

function makeMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "m5-migrations-"));
  // Sort the keys by filename so we can reason about expected output.
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {}
): { exit: number; output: string } {
  const env = { ...process.env, ...VALID_ENV, ...envOverrides };
  try {
    return {
      exit: 0,
      output: execFileSync("node", [SCRIPT, ...args], { encoding: "utf8", env }),
    };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string };
    return { exit: failure.status ?? 1, output: failure.stdout ?? "" };
  }
}

describe("listForwardMigrations (library)", () => {
  it("returns lexicographically ordered .sql files", () => {
    const dir = makeMigrationsDir({
      "0001_a.sql": "CREATE TABLE a(id INT);",
      "0003_c.sql": "CREATE TABLE c(id INT);",
      "0002_b.sql": "CREATE TABLE b(id INT);",
    });
    expect(listForwardMigrations(dir)).toEqual(["0001_a.sql", "0002_b.sql", "0003_c.sql"]);
  });

  it("ignores non-SQL files", () => {
    const dir = makeMigrationsDir({
      "0001_a.sql": "CREATE TABLE a(id INT);",
      "README.md": "# notes",
      "0002_b.sql.tmp": "tmp",
    });
    expect(listForwardMigrations(dir)).toEqual(["0001_a.sql"]);
  });

  it("throws on an empty migrations directory", () => {
    const dir = makeMigrationsDir({});
    expect(() => listForwardMigrations(dir)).toThrow();
  });

  it("uses the repository migrations directory by default", () => {
    const list = listForwardMigrations();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toMatch(/^0001_/);
  });
});

describe("planManagedD1Apply (library)", () => {
  it("produces a list-only plan by default", () => {
    const dir = makeMigrationsDir({
      "0001_x.sql": "CREATE TABLE x(id INT);",
    });
    const plan = planManagedD1Apply(VALID_ENV, { migrationsDir: dir });
    expect(plan.ok).toBe(true);
    expect(plan.ownerIntent).toBe(false);
    expect(plan.commandPlan).toEqual(["wrangler d1 migrations list DB --env pilot --remote"]);
  });

  it("requires the apply token AND the apply flag to escalate", () => {
    const dir = makeMigrationsDir({
      "0001_x.sql": "CREATE TABLE x(id INT);",
    });
    expect(planManagedD1Apply(VALID_ENV, { migrationsDir: dir, apply: true }).ownerIntent).toBe(false);
    expect(
      planManagedD1Apply(VALID_ENV, {
        migrationsDir: dir,
        apply: true,
        applyToken: "synthetic_token",
      }).ownerIntent
    ).toBe(true);
    expect(
      planManagedD1Apply(VALID_ENV, {
        migrationsDir: dir,
        apply: false,
        applyToken: "synthetic_token",
      }).ownerIntent
    ).toBe(false);
  });

  it("refuses to plan when CLOUDFLARE_ACCOUNT_ID is missing", () => {
    const dir = makeMigrationsDir({
      "0001_x.sql": "CREATE TABLE x(id INT);",
    });
    const plan = planManagedD1Apply({ ...VALID_ENV, CLOUDFLARE_ACCOUNT_ID: "" }, { migrationsDir: dir });
    expect(plan.ok).toBe(false);
    expect(plan.missing).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(plan.commandPlan[0]).toContain("migrations list");
  });

  it("refuses to plan when CLOUDFLARE_D1_DATABASE_ID is missing", () => {
    const dir = makeMigrationsDir({
      "0001_x.sql": "CREATE TABLE x(id INT);",
    });
    const plan = planManagedD1Apply({ ...VALID_ENV, CLOUDFLARE_D1_DATABASE_ID: "" }, { migrationsDir: dir });
    expect(plan.ok).toBe(false);
    expect(plan.missing).toContain("CLOUDFLARE_D1_DATABASE_ID");
  });

  it("refuses to plan when migrations directory is empty", () => {
    const dir = makeMigrationsDir({});
    const plan = planManagedD1Apply(VALID_ENV, { migrationsDir: dir });
    expect(plan.ok).toBe(false);
    expect(plan.migrationsError).toBeTruthy();
  });

  it("never echoes the apply token or database id in the plan", () => {
    const dir = makeMigrationsDir({
      "0001_x.sql": "CREATE TABLE x(id INT);",
    });
    const plan = planManagedD1Apply(VALID_ENV, {
      migrationsDir: dir,
      apply: true,
      applyToken: "SUPER_SECRET_TOKEN_DO_NOT_LEAK",
    });
    const dump = JSON.stringify(plan);
    expect(dump).not.toContain("SUPER_SECRET_TOKEN_DO_NOT_LEAK");
    expect(dump).not.toContain(VALID_ENV.CLOUDFLARE_D1_DATABASE_ID);
  });
});

describe("migrate-apply CLI mode", () => {
  it("prints a names-only plan for the repository migrations", () => {
    const result = runCli(["--plan-only"]);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("MIGRATIONS_PLAN_ONLY");
    expect(result.output).toMatch(/MIGRATIONS_COUNT=\d+/);
    expect(result.output).not.toContain(VALID_ENV.CLOUDFLARE_D1_DATABASE_ID);
  });

  it("falls back to plan-only when invoked with no flags", () => {
    const result = runCli([]);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("MIGRATIONS_PLAN_ONLY");
  });

  it("fails closed when account id is missing", () => {
    const result = runCli(["--plan-only"], { CLOUDFLARE_ACCOUNT_ID: "" });
    expect(result.exit).toBe(1);
    expect(result.output).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(result.output).not.toContain(VALID_ENV.CLOUDFLARE_D1_DATABASE_ID);
  });

  it("--apply without a token stays inert", () => {
    const result = runCli(["--apply"]);
    expect(result.exit).toBe(0);
    // Token absent → still plan-only, even when --apply is passed.
    expect(result.output).toContain("MIGRATIONS_PLAN_ONLY");
    expect(result.output).not.toContain("MIGRATIONS_APPLY_INTENT=YES");
  });

  it("--apply with a token reports apply intent yet still prints names only", () => {
    const result = runCli(["--apply"], {
      BANKMANAGE_MIGRATIONS_APPLY_TOKEN: "synthetic_token",
    });
    expect(result.exit).toBe(0);
    expect(result.output).toContain("MIGRATIONS_APPLY_INTENT=YES");
    expect(result.output).not.toContain("synthetic_token");
    expect(result.output).not.toContain(VALID_ENV.CLOUDFLARE_D1_DATABASE_ID);
  });
});

describe("migrate-apply safety guard", () => {
  let realMigrations: string[];

  beforeAll(() => {
    realMigrations = listForwardMigrations();
  });

  it("repository migration files are all in the 000X_prefix.sql form", () => {
    for (const name of realMigrations) {
      expect(name).toMatch(/^00\d{2}_[a-z0-9_]+\.sql$/);
    }
  });

  it("migration filenames never echo the database id", () => {
    expect(realMigrations.join("\n")).not.toContain(VALID_ENV.CLOUDFLARE_D1_DATABASE_ID);
  });
});
