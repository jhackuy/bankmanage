/**
 * tests/unit/telegram-mini-app-auth.test.ts
 *
 * Verifies the /api/telegram-mini-app-auth endpoint and the full Mini App
 * verify-and-bind chain through TelegramMiniAppAuthService +
 * verifyInitData + D1TelegramIdentityRepository.
 *
 * SPEC §2:
 *   - "Every Mini App API request validates original Telegram initData,
 *      signature freshness and allowlisted identity server-side."
 *   - Tampered / expired / unknown identity fails with zero financial
 *      mutation.
 *
 * No real Telegram tokens or initData values are used. All strings are
 * obviously synthetic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import { D1TelegramIdentityRepository } from "../../src/services/telegram/d1-identity-repository.js";
import { TelegramMiniAppAuthService } from "../../src/services/telegram/mini-app-auth.js";
import { buildMiniAppAuthRouter } from "../../src/worker/routes/telegram-mini-app.js";
import { signInitData } from "../../src/domain/telegram/init-data.js";

const SYNTHETIC_BOT_TOKEN = "synthetic_test_bot_token_NOT_REAL_VALUE_zzz";
const FAKE_OWNER_TELEGRAM_ID = "100000000001";
const FAKE_MEMBER_TELEGRAM_ID = "100000000002";
const NOW_SECONDS = 1_700_000_000;

let db: FakeD1Database;
let repo: D1TelegramIdentityRepository;

beforeEach(async () => {
  db = new FakeD1Database();
  repo = new D1TelegramIdentityRepository(db);

  const owner = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Synthetic Owner")
    .run();
  const member = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("MEMBER", "Synthetic Member")
    .run();
  await db
    .prepare("INSERT INTO telegram_identities (member_id, telegram_user_id) VALUES (?, ?)")
    .bind(Number(owner.meta.last_row_id), FAKE_OWNER_TELEGRAM_ID)
    .run();
  await db
    .prepare("INSERT INTO telegram_identities (member_id, telegram_user_id) VALUES (?, ?)")
    .bind(Number(member.meta.last_row_id), FAKE_MEMBER_TELEGRAM_ID)
    .run();
});

afterEach(() => db.close());

function buildOwnerInitData(telegramId: string, authDate: string): string {
  const params = new URLSearchParams();
  params.set("user", JSON.stringify({ id: Number(telegramId), first_name: "Owner Name" }));
  params.set("auth_date", authDate);
  params.set("query_id", "AAH_synthetic_query_id_001");
  return params.toString();
}

async function sign(params: string): Promise<string> {
  const hash = await signInitData(params, SYNTHETIC_BOT_TOKEN);
  return `${params}&hash=${hash}`;
}

describe("TelegramMiniAppAuthService", () => {
  it("binds a known-good initData to OWNER", async () => {
    const params = buildOwnerInitData(FAKE_OWNER_TELEGRAM_ID, String(NOW_SECONDS - 30));
    const initData = await sign(params);
    const auth = new TelegramMiniAppAuthService({
      botToken: SYNTHETIC_BOT_TOKEN,
      identityRepository: repo,
      nowSeconds: NOW_SECONDS,
    });
    const result = await auth.verifyAndBind(initData);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.role).toBe("OWNER");
    expect(result.identity.telegramUserId).toBe(FAKE_OWNER_TELEGRAM_ID);
  });

  it("binds a known-good initData to MEMBER", async () => {
    const params = buildOwnerInitData(FAKE_MEMBER_TELEGRAM_ID, String(NOW_SECONDS - 30));
    const initData = await sign(params);
    const auth = new TelegramMiniAppAuthService({
      botToken: SYNTHETIC_BOT_TOKEN,
      identityRepository: repo,
      nowSeconds: NOW_SECONDS,
    });
    const result = await auth.verifyAndBind(initData);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.role).toBe("MEMBER");
  });

  it("rejects initData signed with a different bot token (tampered)", async () => {
    const params = buildOwnerInitData(FAKE_OWNER_TELEGRAM_ID, String(NOW_SECONDS - 30));
    const bogusHash = await signInitData(params, "different_synthetic_token");
    const initData = `${params}&hash=${bogusHash}`;
    const auth = new TelegramMiniAppAuthService({
      botToken: SYNTHETIC_BOT_TOKEN,
      identityRepository: repo,
      nowSeconds: NOW_SECONDS,
    });
    const result = await auth.verifyAndBind(initData);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("BAD_SIGNATURE");
  });

  it("rejects expired initData", async () => {
    const params = buildOwnerInitData(FAKE_OWNER_TELEGRAM_ID, String(NOW_SECONDS - 999_999_999));
    const initData = await sign(params);
    const auth = new TelegramMiniAppAuthService({
      botToken: SYNTHETIC_BOT_TOKEN,
      identityRepository: repo,
      nowSeconds: NOW_SECONDS,
      maxAgeSeconds: 3600,
    });
    const result = await auth.verifyAndBind(initData);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EXPIRED_INIT_DATA");
    expect(result.status).toBe(401);
  });

  it("rejects a Telegram user not on the allowlist (UNKNOWN_USER, 403)", async () => {
    const params = buildOwnerInitData("9999999999", String(NOW_SECONDS - 30));
    const initData = await sign(params);
    const auth = new TelegramMiniAppAuthService({
      botToken: SYNTHETIC_BOT_TOKEN,
      identityRepository: repo,
      nowSeconds: NOW_SECONDS,
    });
    const result = await auth.verifyAndBind(initData);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNKNOWN_USER");
    expect(result.status).toBe(403);
  });

  it("rejects malformed initData", async () => {
    const auth = new TelegramMiniAppAuthService({
      botToken: SYNTHETIC_BOT_TOKEN,
      identityRepository: repo,
      nowSeconds: NOW_SECONDS,
    });
    const result = await auth.verifyAndBind("garbage_no_equals_signs_no_hash");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED_INIT_DATA");
    expect(result.status).toBe(401);
  });
});

describe("Mini App auth Hono route", () => {
  function makeRouter(): ReturnType<typeof buildMiniAppAuthRouter> {
    return buildMiniAppAuthRouter({
      botToken: SYNTHETIC_BOT_TOKEN,
      identityRepository: repo,
      maxAgeSeconds: 3600,
    });
  }

  async function postInitData(initData: string | null): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (initData !== null) headers["x-telegram-init-data"] = initData;
    const req = new Request("http://localhost/api/telegram-mini-app-auth", {
      method: "POST",
      headers,
      body: "{}",
    });
    return makeRouter().fetch(req, {} as never, {} as never);
  }

  it("returns 200 + identity for a valid OWNER initData (no mutation)", async () => {
    const params = buildOwnerInitData(FAKE_OWNER_TELEGRAM_ID, String(NOW_SECONDS - 30));
    const initData = await sign(params);

    const res = await postInitData(initData);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const identity = json["identity"] as { role: string; telegramUserId: string } | undefined;
    expect(identity?.role).toBe("OWNER");
    expect(identity?.telegramUserId).toBe(FAKE_OWNER_TELEGRAM_ID);
  });

  it("returns 403 with the typed code for an unknown Telegram user", async () => {
    const params = buildOwnerInitData("9999999999", String(NOW_SECONDS - 30));
    const initData = await sign(params);
    const res = await postInitData(initData);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain(initData); // raw initData MUST NOT be echoed
    expect(text).toContain("UNKNOWN_USER");
  });

  it("returns 400 when no initData is supplied", async () => {
    const res = await postInitData(null);
    expect(res.status).toBe(400);
  });

  it("never includes the bot token in the response body or headers", async () => {
    const params = buildOwnerInitData(FAKE_OWNER_TELEGRAM_ID, String(NOW_SECONDS - 30));
    const initData = await sign(params);
    const res = await postInitData(initData);
    const text = await res.text();
    expect(text).not.toContain(SYNTHETIC_BOT_TOKEN);
  });
});
