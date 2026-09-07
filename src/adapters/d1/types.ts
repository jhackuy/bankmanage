/**
 * D1 contract types — the minimal subset of the Cloudflare D1 surface
 * that this project depends on. Declared here with NO Node/Workers imports
 * so the production repository can type-check against the same shape the
 * real `D1Database` binding exposes, without pulling in the fake's
 * Node-only dependencies (better-sqlite3, node:fs, node:path, node:url).
 *
 * Both the fake adapter (`./fake.ts`) and the production repository
 * (`../../services/term-deposit/d1-repository.ts`) import from this module.
 */

/**
 * Subset of `D1ResultMeta` exposed by `@cloudflare/workers-types`.
 * Mirrored locally to keep the fake testable without Workers types.
 */
export interface D1ResultMeta {
  readonly duration: number;
  readonly changes: number;
  readonly last_row_id: number | null;
  readonly served_by?: string;
  readonly rows_read: number;
  readonly rows_written: number;
}

/** Generic D1 result row container. */
export interface D1Result<T = unknown> {
  readonly results: T[];
  readonly success: boolean;
  readonly meta: D1ResultMeta;
  readonly error?: string;
}

/** Result returned by `D1Database.exec()`. */
export interface D1ExecResult {
  readonly count: number;
  readonly duration: number;
}

/** Minimal prepared-statement surface used by this project. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

/** Minimal D1 database surface used by this project. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  dump(): Promise<ArrayBuffer>;
}
