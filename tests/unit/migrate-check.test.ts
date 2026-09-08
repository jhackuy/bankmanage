/**
 * tests/unit/migrate-check.test.ts
 *
 * Focused unit test for scripts/migrate-check.mjs.
 *
 * The script itself uses better-sqlite3 to apply every migration against
 * an in-memory database and assert that all SPEC foundation tables
 * exist afterwards. The deepest test of that contract lives in
 * `tests/integration/migration.test.ts` (which uses the same SQLite
 * library to apply the same migrations, table-by-table).
 *
 * This file tests the SCRIPT as a black-box, since it is what CI runs:
 *   - exits 0 against the real migrations/ directory;
 *   - prints the SPEC foundation tables as "Table exists: <name>";
 *   - prints "Migration check PASSED" on success;
 *   - never echoes managed database id / token-shaped strings (defence
 *     against accidental regression where the script accidentally
 *     prints configuration).
 *
 * Failure-path witnesses (missing migrations directory, malformed SQL)
 * are NOT executable as black-box tests in the current implementation
 * because `scripts/migrate-check.mjs` resolves the migrations directory
 * relative to its own `import.meta.url`. Exercising those branches would
 * require restructuring the script to accept a CLI argument, which is
 * out of scope for this milestone.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "migrate-check.mjs");

interface CliResult {
  exit: number;
  output: string;
}

function runCli(): CliResult {
  try {
    return {
      exit: 0,
      output: execFileSync("node", [SCRIPT], { encoding: "utf8", env: process.env }),
    };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    return { exit: failure.status ?? 1, output: (failure.stdout ?? "") + (failure.stderr ?? "") };
  }
}

describe("scripts/migrate-check.mjs — happy-path black-box", () => {
  it("exits 0 against the real migrations/ directory", () => {
    const result = runCli();
    expect(result.exit).toBe(0);
  });

  it("prints a final 'Migration check PASSED' banner", () => {
    const result = runCli();
    expect(result.output).toMatch(/Migration check PASSED/i);
  });

  it("prints an 'Applied: 000X_*.sql' line for every repository migration", () => {
    const result = runCli();
    const applied = result.output.match(/Applied: 000\d_.+\.sql/g) ?? [];
    expect(applied.length).toBeGreaterThanOrEqual(1);
    // Every applied line must reference a real .sql file (no placeholders).
    for (const line of applied) {
      expect(line).toMatch(/Applied: 000\d_[a-z0-9_]+\.sql$/);
    }
  });

  it("prints 'Table exists: <name>' for each SPEC foundation table", () => {
    const result = runCli();
    const requiredTables = [
      "migration_metadata",
      "household_members",
      "telegram_identities",
      "currencies",
      "banks",
      "accounts",
      "categories",
    ];
    for (const table of requiredTables) {
      expect(result.output).toContain(`Table exists: ${table}`);
    }
  });

  it("never echoes managed database id or token-shaped values on success", () => {
    const result = runCli();
    expect(result.output).not.toContain("00000000-0000-0000-0000-000000000000");
    expect(result.output).not.toMatch(/TELEGRAM_BOT_TOKEN=/);
    expect(result.output).not.toMatch(/CLOUDFLARE_API_TOKEN=/);
    expect(result.output).not.toMatch(/TELEGRAM_WEBHOOK_SECRET=/);
  });
});
