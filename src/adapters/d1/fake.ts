/**
 * Fake in-memory D1 binding for tests.
 *
 * Wraps better-sqlite3 (synchronous SQLite) behind the D1Database async
 * interface used by Cloudflare Workers. Tests use this binding in place of
 * a real D1 instance so the entire repository/service stack can be exercised
 * deterministically in CI without Cloudflare credentials.
 *
 * The fake applies the project's SQL migrations during construction so the
 * surface area is identical to a fresh production D1 database. Foreign-key
 * enforcement is enabled to match Cloudflare D1.
 *
 * IMPORTANT: This adapter must stay bit-for-bit compatible with the real D1
 * binding exposed by `@cloudflare/workers-types`. If the real API gains
 * methods, add them here with the same semantics.
 */

import Database, { type Database as BetterSqliteDatabase, type Statement } from "better-sqlite3";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// D1 surface types live in a types-only module so production code can
// import them without pulling in Node-only fake dependencies.
export type { D1Database, D1ExecResult, D1PreparedStatement, D1Result, D1ResultMeta } from "./types.js";
import type { D1Database, D1PreparedStatement, D1Result, D1ExecResult } from "./types.js";

// ── Implementation ──────────────────────────────────────────────────────────

function findMigrationsDir(startDir: string): string {
  // Walk up until we find a migrations/ directory. This makes the adapter
  // work both when imported from src/ and from dist/.
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "migrations");
    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // continue
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate migrations/ directory starting from ${startDir}`);
}

/**
 * Apply every `migrations/*.sql` file in lexicographic order. The migration
 * script is idempotent (CREATE TABLE IF NOT EXISTS, INSERT OR IGNORE) so this
 * also works against an already-seeded database.
 */
function applyMigrations(db: BetterSqliteDatabase, migrationsDir: string): void {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    db.exec(sql);
  }
}

class FakeD1Statement implements D1PreparedStatement {
  private readonly _stmt: Statement;
  private _params: unknown[] = [];

  constructor(stmt: Statement) {
    this._stmt = stmt;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this._params = values;
    return this;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = this._stmt.get(...(this._params as never[])) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    if (colName !== undefined) {
      const value = row[colName];
      if (value === undefined) return null;
      return value as T;
    }
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this._stmt.all(...(this._params as never[])) as T[];
    return {
      results: rows,
      success: true,
      meta: {
        duration: 0,
        changes: 0,
        last_row_id: null,
        served_by: "fake-d1",
        rows_read: rows.length,
        rows_written: 0,
      },
    };
  }

  /** Synchronous core of run(); also invoked by batch() inside its transaction. */
  runSync<T = Record<string, unknown>>(): D1Result<T> {
    const result = this._stmt.run(...(this._params as never[]));
    return {
      results: [],
      success: true,
      meta: {
        duration: 0,
        changes: result.changes,
        last_row_id:
          result.lastInsertRowid === undefined || result.lastInsertRowid === null
            ? null
            : Number(result.lastInsertRowid),
        served_by: "fake-d1",
        rows_read: 0,
        rows_written: result.changes,
      },
    };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.runSync<T>();
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    // better-sqlite3 supports .raw() returning positional column values per
    // row. We expose .raw() so the adapter surface mirrors D1 exactly; the
    // repository layer does not call it. Cast through unknown[] for the
    // better-sqlite3 typing quirk where raw() returns a typed iterator.
    const params = this._params as unknown[];
    const rows = this._stmt.raw().all(...(params as never[])) as unknown[];
    return rows as T[];
  }

  /** Test helper: the bound parameters array. */
  get boundParams(): readonly unknown[] {
    return this._params;
  }
}

export interface FakeD1DatabaseOptions {
  /** Skip applying migrations on construction (default: false). */
  readonly skipMigrations?: boolean;
  /** Override the auto-discovered migrations directory. */
  readonly migrationsDir?: string;
}

export class FakeD1Database implements D1Database {
  private readonly _db: BetterSqliteDatabase;
  private readonly _statements: FakeD1Statement[] = [];

  constructor(opts: FakeD1DatabaseOptions = {}) {
    this._db = new Database(":memory:");
    this._db.pragma("foreign_keys = ON");
    if (!opts.skipMigrations) {
      const startDir = dirname(fileURLToPath(import.meta.url));
      const migrationsDir = opts.migrationsDir ?? findMigrationsDir(startDir);
      applyMigrations(this._db, migrationsDir);
    }
  }

  prepare(query: string): D1PreparedStatement {
    const stmt = new FakeD1Statement(this._db.prepare(query));
    this._statements.push(stmt);
    return stmt;
  }

  /**
   * Execute multiple statements in a single SQLite transaction. If any
   * statement throws, the transaction is rolled back and no rows are
   * persisted. This mirrors Cloudflare D1's batch() atomicity guarantee.
   */
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const stmtObjects = statements.map((s) => s as FakeD1Statement);
    const txn = this._db.transaction((items: FakeD1Statement[]) => {
      const out: D1Result<T>[] = [];
      for (const item of items) {
        out.push(item.runSync<T>());
      }
      return out;
    });
    return txn(stmtObjects);
  }

  async exec(query: string): Promise<D1ExecResult> {
    const start = Date.now();
    this._db.exec(query);
    return { count: 1, duration: Date.now() - start };
  }

  async dump(): Promise<ArrayBuffer> {
    // Serialize the in-memory database to a binary SQLite blob. Tests do
    // not normally need this, but it keeps the surface complete.
    const buffer = this._db.serialize();
    const ab = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(ab).set(buffer);
    return ab;
  }

  /** Test helper: close the underlying SQLite handle. */
  close(): void {
    this._db.close();
  }

  /** Test helper: total elapsed seconds since epoch (sanity probe). */
  get age(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** Test helper: number of prepared statements handed out. */
  get statementCount(): number {
    return this._statements.length;
  }
}

/**
 * Convenience factory. Applies migrations by default.
 */
export function createFakeD1Database(opts: FakeD1DatabaseOptions = {}): FakeD1Database {
  return new FakeD1Database(opts);
}
