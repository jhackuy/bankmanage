#!/usr/bin/env node
/**
 * scripts/migrate-check.mjs
 *
 * Verifies that all SQL migration files in migrations/ can be applied to a
 * fresh in-memory SQLite database without error.
 *
 * Run: node scripts/migrate-check.mjs
 * Exit 0 = all migrations applied successfully.
 * Exit 1 = error (printed to stderr).
 *
 * Uses better-sqlite3 (sync) to avoid async complexity in a check script.
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

try {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.error("No migration files found in", MIGRATIONS_DIR);
    process.exit(1);
  }

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    db.exec(sql);
    console.log(`  ✓ Applied: ${file}`);
  }

  // Verify expected tables exist
  const expectedTables = [
    "migration_metadata",
    "household_members",
    "telegram_identities",
    "currencies",
    "banks",
    "accounts",
    "categories",
  ];

  for (const table of expectedTables) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!row) {
      throw new Error(`Expected table not found after migration: ${table}`);
    }
    console.log(`  ✓ Table exists: ${table}`);
  }

  db.close();
  console.log("\nMigration check PASSED.");
  process.exit(0);
} catch (err) {
  console.error(
    "\nMigration check FAILED:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}
