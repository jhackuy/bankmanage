/**
 * D1 implementation of the Telegram identity repository.
 *
 * Joins `telegram_identities` (1:1 with `household_members`) and applies the
 * active-member guard. All SQL is parameterized. No raw D1 binding escapes
 * this module.
 *
 * The query is keyed on `telegram_identities.telegram_user_id` which has a
 * UNIQUE constraint in migration 0001 and an index — lookup is O(log n).
 */

import type { D1Database } from "../../adapters/d1/types.js";
import type { MemberRole } from "../../adapters/telegram/interface.js";
import { type ResolvedTelegramIdentity, type TelegramIdentityRepository } from "./identity-repository.js";

interface IdentityRow {
  telegram_user_id: string;
  member_id: number;
  role: string;
}

function rowToResolved(row: IdentityRow): ResolvedTelegramIdentity | null {
  if (row.role !== "OWNER" && row.role !== "MEMBER") return null;
  return {
    telegramUserId: row.telegram_user_id,
    memberId: row.member_id,
    role: row.role as MemberRole,
  };
}

const LOOKUP_SQL = `SELECT ti.telegram_user_id AS telegram_user_id,
                          hm.id              AS member_id,
                          hm.role            AS role
                     FROM telegram_identities ti
                     JOIN household_members hm ON hm.id = ti.member_id
                    WHERE hm.active = 1`;

export class D1TelegramIdentityRepository implements TelegramIdentityRepository {
  constructor(private readonly db: D1Database) {}

  async findByTelegramUserId(telegramUserId: string): Promise<ResolvedTelegramIdentity | null> {
    if (typeof telegramUserId !== "string" || telegramUserId.length === 0) {
      return null;
    }
    const row = await this.db
      .prepare(`${LOOKUP_SQL} AND ti.telegram_user_id = ? LIMIT 1`)
      .bind(telegramUserId)
      .first<IdentityRow>();
    if (row === null) return null;
    return rowToResolved(row);
  }

  async findByMemberId(memberId: number): Promise<ResolvedTelegramIdentity | null> {
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return null;
    }
    const row = await this.db
      .prepare(`${LOOKUP_SQL} AND hm.id = ? LIMIT 1`)
      .bind(memberId)
      .first<IdentityRow>();
    if (row === null) return null;
    return rowToResolved(row);
  }

  async listAll(): Promise<readonly ResolvedTelegramIdentity[]> {
    const result = await this.db.prepare(LOOKUP_SQL).all<IdentityRow>();
    const out: ResolvedTelegramIdentity[] = [];
    for (const row of result.results) {
      const resolved = rowToResolved(row);
      if (resolved !== null) out.push(resolved);
    }
    return out;
  }
}
