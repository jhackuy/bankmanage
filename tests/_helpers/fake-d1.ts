/**
 * Test helper: builds a fresh in-memory FakeD1Database with migrations
 * already applied. Each test gets its own binding so there is zero
 * cross-test state leakage.
 */

import { FakeD1Database, type D1Database } from "../../src/adapters/d1/fake.js";

export function createTestDb(): FakeD1Database {
  return new FakeD1Database();
}

/** Convenience alias matching the D1Database typing used by the adapter. */
export type TestD1 = D1Database;
