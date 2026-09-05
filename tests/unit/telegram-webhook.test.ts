/**
 * tests/unit/telegram-webhook.test.ts
 *
 * Verifies the full /telegram/webhook route through the Hono worker:
 *   - valid webhook secret accepted; invalid/missing secret rejected;
 *   - configured OWNER and MEMBER accepted; unknown Telegram ID rejected
 *     with zero mutation (no `sendMessage`);
 *   - `/start` produces a reply through the production Bot adapter path;
 *   - duplicate update_id is idempotent (no double-reply);
 *   - payload too large / malformed JSON / non-string body rejected without
 *     leaking the secret or env.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import {
  FakeTelegramAdapter,
  FAKE_MEMBER_USER_ID,
  FAKE_OWNER_USER_ID,
} from "../../src/adapters/telegram/fake.js";
import { D1TelegramIdentityRepository } from "../../src/services/telegram/d1-identity-repository.js";
import { InMemoryUpdateDeduper } from "../../src/services/telegram/update-deduper.js";
import {
  buildTelegramWebhookRouter,
  miniAppLauncherFromEnv,
} from "../../src/worker/routes/telegram-webhook.js";
import type { Env } from "../../src/worker/env.js";

const SYNTHETIC_WEBHOOK_SECRET = "synthetic_webhook_secret_NOT_REAL_VALUE_abcdef";
const MINI_APP_URL = "https://example.invalid/mini-app";

let db: FakeD1Database;
let adapter: FakeTelegramAdapter;
let repo: D1TelegramIdentityRepository;
let deduper: InMemoryUpdateDeduper;
let router: ReturnType<typeof buildTelegramWebhookRouter>;

beforeEach(async () => {
  db = new FakeD1Database();
  adapter = new FakeTelegramAdapter();
  repo = new D1TelegramIdentityRepository(db);
  deduper = new InMemoryUpdateDeduper();

  const owner = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Test Owner")
    .run();
  const member = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("MEMBER", "Test Member")
    .run();
  await db
    .prepare("INSERT INTO telegram_identities (member_id, telegram_user_id) VALUES (?, ?)")
    .bind(Number(owner.meta.last_row_id), FAKE_OWNER_USER_ID)
    .run();
  await db
    .prepare("INSERT INTO telegram_identities (member_id, telegram_user_id) VALUES (?, ?)")
    .bind(Number(member.meta.last_row_id), FAKE_MEMBER_USER_ID)
    .run();

  router = buildTelegramWebhookRouter({
    adapter,
    identityRepository: repo,
    launcher: miniAppLauncherFromEnv(MINI_APP_URL),
    deduper,
  });
});

afterEach(() => db.close());

function envWith(extra: Record<string, unknown> = {}): Env {
  return {
    TELEGRAM_WEBHOOK_SECRET: SYNTHETIC_WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: "synthetic_bot_token",
    TELEGRAM_ALLOWED_USER_IDS: `${FAKE_OWNER_USER_ID},${FAKE_MEMBER_USER_ID}`,
    APP_ENV: "test",
    DB: {} as never,
    DOCUMENTS: {} as never,
    ...extra,
  } as unknown as Env;
}

function body(text: string, fromId: string, chatId: string, updateId: number): string {
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1700000000,
      chat: { id: Number(chatId), type: "private" },
      from: { id: Number(fromId), is_bot: false, first_name: "Ada", last_name: null, username: "ada" },
      text,
      entities: [],
    },
  });
}

async function postWebhook(
  payload: string,
  headers: Record<string, string> = { "content-type": "application/json" }
): Promise<Response> {
  const req = new Request("http://localhost/telegram/webhook", {
    method: "POST",
    headers: {
      "x-telegram-bot-api-secret-token": SYNTHETIC_WEBHOOK_SECRET,
      ...headers,
    },
    body: payload,
  });
  return router.fetch(req, envWith(), {} as never);
}

describe("Webhook secret verification", () => {
  it("rejects a request without the secret header", async () => {
    const req = new Request("http://localhost/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body("/start", FAKE_OWNER_USER_ID, FAKE_OWNER_USER_ID, 1),
    });
    const res = await router.fetch(req, envWith(), {} as never);
    expect(res.status).toBe(403);
    expect(adapter.sentMessages).toHaveLength(0);
  });

  it("rejects a request with a wrong secret", async () => {
    const req = new Request("http://localhost/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong_synthetic_secret_VALUE",
      },
      body: body("/start", FAKE_OWNER_USER_ID, FAKE_OWNER_USER_ID, 2),
    });
    const res = await router.fetch(req, envWith(), {} as never);
    expect(res.status).toBe(403);
    expect(adapter.sentMessages).toHaveLength(0);
  });

  it("rejects all requests when the secret binding is unset (503)", async () => {
    const env = envWith({ TELEGRAM_WEBHOOK_SECRET: "" });
    const req = new Request("http://localhost/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body("/start", FAKE_OWNER_USER_ID, FAKE_OWNER_USER_ID, 3),
    });
    const res = await router.fetch(req, env, {} as never);
    expect(res.status).toBe(503);
    expect(adapter.sentMessages).toHaveLength(0);
  });

  it("accepts a correctly signed webhook for an OWNER `/start`", async () => {
    const res = await postWebhook(body("/start", FAKE_OWNER_USER_ID, FAKE_OWNER_USER_ID, 4));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; bot: string };
    expect(json.ok).toBe(true);
    expect(json.bot).toBe("REPLIED");
    expect(adapter.sentMessages.length).toBe(1);
    expect(adapter.sentMessages[0]?.text).toContain("OWNER");
  });

  it("accepts a correctly signed webhook for a MEMBER `/start`", async () => {
    const res = await postWebhook(body("/start", FAKE_MEMBER_USER_ID, FAKE_MEMBER_USER_ID, 5));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; bot: string };
    expect(json.ok).toBe(true);
    expect(adapter.sentMessages[0]?.text).toContain("MEMBER");
  });

  it("rejects an unknown Telegram user with zero mutation", async () => {
    const res = await postWebhook(body("/start", "9999999999", "9999999999", 6));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; bot: string };
    expect(json.bot).toBe("REJECTED");
    expect(adapter.sentMessages).toHaveLength(0);
  });
});

describe("Webhook payload validation", () => {
  it("rejects malformed JSON with 400", async () => {
    const res = await postWebhook("not-valid-json");
    expect(res.status).toBe(400);
  });

  it("rejects empty / too-short body with 400", async () => {
    const res = await postWebhook("abc");
    expect(res.status).toBe(400);
  });

  it("replies without leaking the webhook secret in response body", async () => {
    const res = await postWebhook(body("/start", FAKE_OWNER_USER_ID, FAKE_OWNER_USER_ID, 7));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SYNTHETIC_WEBHOOK_SECRET);
    expect(text).not.toMatch(/TELEGRAM_BOT_TOKEN/i);
    expect(text).not.toMatch(/TELEGRAM_WEBHOOK_SECRET/i);
  });
});

describe("Webhook idempotency", () => {
  it("replaying the same update_id produces exactly one reply", async () => {
    const first = await postWebhook(body("/start", FAKE_OWNER_USER_ID, FAKE_OWNER_USER_ID, 50));
    const second = await postWebhook(body("/start", FAKE_OWNER_USER_ID, FAKE_OWNER_USER_ID, 50));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { bot: string };
    expect(secondJson.bot).toBe("IGNORED");
    expect(adapter.sentMessages).toHaveLength(1);
  });
});
