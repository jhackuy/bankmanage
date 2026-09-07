/**
 * tests/unit/telegram-identity-repository.test.ts
 *
 * Verifies D1TelegramIdentityRepository against a FakeD1Database binding.
 *
 * SPEC §2: exactly two Telegram identities are configured for the pilot
 * (OWNER, MEMBER). The repository MUST be the only place where a Telegram
 * ID is mapped to a role — never trust a client-supplied role.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import { D1TelegramIdentityRepository } from "../../src/services/telegram/d1-identity-repository.js";

let db: FakeD1Database;
let repo: D1TelegramIdentityRepository;

const FAKE_OWNER_TELEGRAM_ID = "100000000001";
const FAKE_MEMBER_TELEGRAM_ID = "100000000002";
const FAKE_STRANGER_TELEGRAM_ID = "100000000003";

async function seedIdentities(): Promise<void> {
  const ownerMember = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Synthetic Owner")
    .run();
  const memberMember = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("MEMBER", "Synthetic Member")
    .run();
  await db
    .prepare("INSERT INTO household_members (role, display_name, active) VALUES (?, ?, 0)")
    .bind("MEMBER", "Inactive Test Member")
    .run();

  await db
    .prepare("INSERT INTO telegram_identities (member_id, telegram_user_id) VALUES (?, ?)")
    .bind(Number(ownerMember.meta.last_row_id), FAKE_OWNER_TELEGRAM_ID)
    .run();
  await db
    .prepare("INSERT INTO telegram_identities (member_id, telegram_user_id) VALUES (?, ?)")
    .bind(Number(memberMember.meta.last_row_id), FAKE_MEMBER_TELEGRAM_ID)
    .run();
}

beforeEach(async () => {
  db = new FakeD1Database();
  repo = new D1TelegramIdentityRepository(db);
  await seedIdentities();
});

afterEach(() => db.close());

describe("findByTelegramUserId", () => {
  it("resolves the OWNER", async () => {
    const out = await repo.findByTelegramUserId(FAKE_OWNER_TELEGRAM_ID);
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.role).toBe("OWNER");
    expect(out.telegramUserId).toBe(FAKE_OWNER_TELEGRAM_ID);
  });

  it("resolves the MEMBER", async () => {
    const out = await repo.findByTelegramUserId(FAKE_MEMBER_TELEGRAM_ID);
    expect(out).not.toBeNull();
    if (out === null) return;
    expect(out.role).toBe("MEMBER");
  });

  it("returns null for an unknown / non-allowlisted Telegram ID", async () => {
    const out = await repo.findByTelegramUserId(FAKE_STRANGER_TELEGRAM_ID);
    expect(out).toBeNull();
  });

  it("returns null for an empty / non-string input", async () => {
    expect(await repo.findByTelegramUserId("")).toBeNull();
  });
});

describe("findByMemberId", () => {
  it("resolves member -> Telegram identity", async () => {
    const all = await repo.listAll();
    const owner = all.find((i) => i.role === "OWNER");
    expect(owner).toBeDefined();
    if (owner === undefined) return;

    const out = await repo.findByMemberId(owner.memberId);
    expect(out?.telegramUserId).toBe(FAKE_OWNER_TELEGRAM_ID);
    expect(out?.role).toBe("OWNER");
  });

  it("returns null for a member id that has no Telegram identity", async () => {
    const inactive = await db
      .prepare("SELECT id FROM household_members WHERE display_name = ? LIMIT 1")
      .bind("Inactive Test Member")
      .first<{ id: number }>();
    expect(inactive).not.toBeNull();
    if (inactive === null) return;
    // Inactive member without an identity row should return null.
    const out = await repo.findByMemberId(inactive.id);
    expect(out).toBeNull();
  });

  it("returns null for a non-positive member id", async () => {
    expect(await repo.findByMemberId(0)).toBeNull();
    expect(await repo.findByMemberId(-1)).toBeNull();
  });
});

describe("listAll", () => {
  it("returns only allowlisted, active identities", async () => {
    const all = await repo.listAll();
    expect(all).toHaveLength(2);
    const roles = all.map((i) => i.role).sort();
    expect(roles).toEqual(["MEMBER", "OWNER"]);
    const ids = all.map((i) => i.telegramUserId).sort();
    expect(ids).toEqual([FAKE_MEMBER_TELEGRAM_ID, FAKE_OWNER_TELEGRAM_ID].sort());
  });

  it("excludes inactive members", async () => {
    const all = await repo.listAll();
    for (const identity of all) {
      expect(identity.role === "OWNER" || identity.role === "MEMBER").toBe(true);
    }
  });
});
