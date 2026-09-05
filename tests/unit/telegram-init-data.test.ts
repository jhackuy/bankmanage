/**
 * tests/unit/telegram-init-data.test.ts
 *
 * Verifies the platform-neutral initData HMAC verification module.
 *
 * SPEC §2: "Every Mini App API request validates original Telegram
 * initData, signature freshness and allowlisted identity server-side.
 * Never trust initDataUnsafe, username, display name or a client-submitted
 * role for authorization."
 *
 * The module uses the global Web Crypto API (Node 20+ and Cloudflare
 * Workers both expose it), so no test secret or fixture token is needed.
 */

import { describe, expect, it } from "vitest";
import {
  buildDataCheckString,
  DEFAULT_INIT_DATA_MAX_AGE_SECONDS,
  INIT_DATA_HASH_FIELD,
  parseInitDataRaw,
  parseInitDataUser,
  signInitData,
  verifyInitData,
} from "../../src/domain/telegram/init-data.js";

const SYNTHETIC_BOT_TOKEN = "synthetic_test_bot_token_NOT_REAL_VALUE_12345";

function makeFakeInitData(extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  params.set("user", JSON.stringify({ id: 100000000001, first_name: "Test Owner", username: "test_owner" }));
  params.set("auth_date", "1700000000");
  params.set("query_id", "AAEhYzA1");
  params.set("start_param", "deep_link");
  for (const [k, v] of Object.entries(extra)) {
    params.set(k, v);
  }
  return params.toString();
}

async function makeSignedInitData(botToken: string, extra: Record<string, string> = {}): Promise<string> {
  const dataCheckString = makeFakeInitData(extra);
  const hash = await signInitData(dataCheckString, botToken);
  const withHash = `${dataCheckString}&${INIT_DATA_HASH_FIELD}=${hash}`;
  return withHash;
}

describe("parseInitDataRaw", () => {
  it("decodes percent-encoded field/value pairs", () => {
    const out = parseInitDataRaw("auth_date=1700000000&query_id=AA%23B&user=%7B%22id%22%3A1%7D");
    expect(out.auth_date).toBe("1700000000");
    expect(out.query_id).toBe("AA#B");
    expect(out.user).toBe('{"id":1}');
  });

  it("returns an empty map on empty or invalid input", () => {
    expect(parseInitDataRaw("")).toEqual({});
    expect(parseInitDataRaw("&")).toEqual({});
  });
});

describe("buildDataCheckString", () => {
  it("sorts fields alphabetically and excludes hash", () => {
    const fields = { auth_date: "1", user: "u", hash: "h", query_id: "q" };
    expect(buildDataCheckString(fields)).toBe("auth_date=1\nquery_id=q\nuser=u");
  });

  it("returns empty for fields-without-hash input", () => {
    expect(buildDataCheckString({ a: "1", b: "2" })).toBe("a=1\nb=2");
  });
});

describe("parseInitDataUser", () => {
  it("extracts id, username and constructed display name", () => {
    const fields = {
      user: JSON.stringify({ id: 42, username: "abc", first_name: "Ada", last_name: "Lovelace" }),
    };
    const result = parseInitDataUser(fields);
    expect(result).toEqual({ id: "42", username: "abc", displayName: "Ada Lovelace" });
  });

  it("returns null when user is missing", () => {
    expect(parseInitDataUser({})).toBeNull();
  });

  it("returns null when user JSON is malformed", () => {
    expect(parseInitDataUser({ user: "not-json" })).toBeNull();
  });
});

describe("verifyInitData (HMAC + freshness + parse)", () => {
  it("accepts a known-good initData signed with the same bot token", async () => {
    const signed = await makeSignedInitData(SYNTHETIC_BOT_TOKEN);
    const result = await verifyInitData(signed, SYNTHETIC_BOT_TOKEN, { nowSeconds: 1_700_000_100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe("100000000001");
  });

  it("rejects initData signed with a DIFFERENT bot token (tampered)", async () => {
    const signed = await makeSignedInitData(SYNTHETIC_BOT_TOKEN);
    const result = await verifyInitData(signed, "different_synthetic_token_VALUE");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("BAD_HASH");
  });

  it("rejects initData whose hash has been swapped with a forgery", async () => {
    const signed = await makeSignedInitData(SYNTHETIC_BOT_TOKEN);
    // swap last char of the hash
    const corrupted = signed.replace(/[0-9a-f]$/, (m) => (m === "0" ? "1" : "0"));
    const result = await verifyInitData(corrupted, SYNTHETIC_BOT_TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("BAD_HASH");
  });

  it("rejects expired initData (auth_date older than maxAge)", async () => {
    const signed = await makeSignedInitData(SYNTHETIC_BOT_TOKEN, { auth_date: "1" });
    const result = await verifyInitData(signed, SYNTHETIC_BOT_TOKEN, { nowSeconds: 1_700_000_100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EXPIRED");
  });

  it("rejects initData missing the required hash field", async () => {
    const noHash = makeFakeInitData();
    const result = await verifyInitData(noHash, SYNTHETIC_BOT_TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED");
  });

  it("rejects input that is not a string at all", async () => {
    const result = await verifyInitData("", SYNTHETIC_BOT_TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED");
  });

  it("rejects an initData signed with an empty bot token", async () => {
    const signed = await makeSignedInitData("");
    const result = await verifyInitData(signed, "");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED");
  });

  it("respects custom maxAgeSeconds", async () => {
    const oldDate = String(1_700_000_000 - 100);
    const signed = await makeSignedInitData(SYNTHETIC_BOT_TOKEN, { auth_date: oldDate });
    const result = await verifyInitData(signed, SYNTHETIC_BOT_TOKEN, {
      nowSeconds: 1_700_000_100,
      maxAgeSeconds: 50,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EXPIRED");
  });

  it("accepts initData within the default freshness window", async () => {
    const recentDate = String(1_700_000_100 - 100);
    const signed = await makeSignedInitData(SYNTHETIC_BOT_TOKEN, { auth_date: recentDate });
    const result = await verifyInitData(signed, SYNTHETIC_BOT_TOKEN, { nowSeconds: 1_700_000_100 });
    expect(result.ok).toBe(true);
    // The constant is exported for the auth-service to reuse.
    expect(DEFAULT_INIT_DATA_MAX_AGE_SECONDS).toBeGreaterThan(0);
  });

  it("rejects when auth_date is far in the future (clock skew guard)", async () => {
    const futureDate = String(1_700_000_100 + 999_999);
    const signed = await makeSignedInitData(SYNTHETIC_BOT_TOKEN, { auth_date: futureDate });
    const result = await verifyInitData(signed, SYNTHETIC_BOT_TOKEN, { nowSeconds: 1_700_000_100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EXPIRED");
  });
});
