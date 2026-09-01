/**
 * auth-boundary.test.ts
 *
 * Verifies the authorization boundary using the fake Telegram adapter:
 * - Unknown/unauthorized identities throw TelegramAuthError (403-equivalent).
 * - No mutation occurs on authorization failure.
 * - Username/display_name/client-submitted role is never trusted.
 * - Known test identities are resolved to the correct role.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  FakeTelegramAdapter,
  TelegramAuthError,
  FAKE_OWNER_INIT_DATA,
  FAKE_MEMBER_INIT_DATA,
  FAKE_UNAUTHORIZED_INIT_DATA,
  FAKE_OWNER_USER_ID,
  FAKE_MEMBER_USER_ID,
} from "../../src/adapters/telegram/index.js";

describe("Telegram auth boundary", () => {
  let adapter: FakeTelegramAdapter;

  beforeEach(() => {
    adapter = new FakeTelegramAdapter();
  });

  it("resolves OWNER identity for fake owner initData", async () => {
    const identity = await adapter.verifyInitData(FAKE_OWNER_INIT_DATA);
    expect(identity.role).toBe("OWNER");
    expect(identity.telegramUserId).toBe(FAKE_OWNER_USER_ID);
  });

  it("resolves MEMBER identity for fake member initData", async () => {
    const identity = await adapter.verifyInitData(FAKE_MEMBER_INIT_DATA);
    expect(identity.role).toBe("MEMBER");
    expect(identity.telegramUserId).toBe(FAKE_MEMBER_USER_ID);
  });

  it("throws TelegramAuthError for unauthorized initData", async () => {
    await expect(adapter.verifyInitData(FAKE_UNAUTHORIZED_INIT_DATA)).rejects.toThrow(TelegramAuthError);
  });

  it("TelegramAuthError has status 403", async () => {
    let caughtError: TelegramAuthError | undefined;
    try {
      await adapter.verifyInitData(FAKE_UNAUTHORIZED_INIT_DATA);
    } catch (e) {
      caughtError = e as TelegramAuthError;
    }
    expect(caughtError).toBeDefined();
    expect(caughtError?.status).toBe(403);
  });

  it("throws for empty initData", async () => {
    await expect(adapter.verifyInitData("")).rejects.toThrow(TelegramAuthError);
  });

  it("throws for initData with username but no allowlist match (never trust username alone)", async () => {
    // Username-containing string that looks like real data but is not allowlisted
    await expect(adapter.verifyInitData("user=fakeuser&role=OWNER")).rejects.toThrow(TelegramAuthError);
  });

  it("zero mutation occurs after authorization failure", async () => {
    const messagesBefore = adapter.sentMessages.length;
    try {
      await adapter.verifyInitData(FAKE_UNAUTHORIZED_INIT_DATA);
    } catch {
      // Expected
    }
    // No messages sent as side-effect of a failed auth
    expect(adapter.sentMessages.length).toBe(messagesBefore);
  });

  it("identity telegramUserId is numeric string, not username", () => {
    // Telegram user IDs are numeric; username-based auth is explicitly forbidden
    expect(FAKE_OWNER_USER_ID).toMatch(/^\d+$/);
    expect(FAKE_MEMBER_USER_ID).toMatch(/^\d+$/);
  });

  it("OWNER and MEMBER user IDs are distinct", () => {
    expect(FAKE_OWNER_USER_ID).not.toBe(FAKE_MEMBER_USER_ID);
  });
});
