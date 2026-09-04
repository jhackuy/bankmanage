/**
 * Test helper: writes a fake household_member row for use in integration tests
 * that depend on a pre-seeded active member identity. Internal-only fixture;
 * never imported by production code.
 */

import type { D1Database } from "../../adapters/d1/types.js";

export async function seedActiveMember(
  db: D1Database,
  params: { id: number; displayName: string }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO household_members (id, display_name, active, created_at, updated_at) VALUES (?, ?, 1, datetime('now'), datetime('now'))"
    )
    .bind(params.id, params.displayName)
    .run();
}
