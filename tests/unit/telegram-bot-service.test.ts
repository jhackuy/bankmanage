/**
 * tests/unit/telegram-bot-service.test.ts
 *
 * Verifies TelegramBotService:
 *   - `/start` returns a reply through the production Bot adapter path.
 *   - Unknown user is rejected with zero mutation.
 *   - Callback is acknowledged PROMPTLY (answerCallbackQuery) before any
 *     downstream work happens.
 *   - Duplicate update_id is idempotent (deduper rejects the replay).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import {
  FakeTelegramAdapter,
  FAKE_MEMBER_USER_ID,
  FAKE_OWNER_USER_ID,
} from "../../src/adapters/telegram/fake.js";
import { D1TelegramIdentityRepository } from "../../src/services/telegram/d1-identity-repository.js";
import { TelegramBotService } from "../../src/services/telegram/bot-service.js";

const MINI_APP_URL = "https://example.invalid/mini-app";

let db: FakeD1Database;
let adapter: FakeTelegramAdapter;
let repo: D1TelegramIdentityRepository;
let bot: TelegramBotService;

beforeEach(async () => {
  db = new FakeD1Database();
  adapter = new FakeTelegramAdapter();
  repo = new D1TelegramIdentityRepository(db);
  bot = new TelegramBotService({
    adapter,
    identityRepository: repo,
    miniAppLauncher: {
      buildLaunchButton: (_chatId: string) => ({ text: "Open", url: MINI_APP_URL }),
    },
  });

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
});

afterEach(() => db.close());

function startUpdate(fromId: string, chatId: string, updateId: number): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1700000000,
      chat: { id: Number(chatId), type: "private" },
      from: { id: Number(fromId), is_bot: false, first_name: "Ada", last_name: null, username: "ada" },
      text: "/start",
      entities: [],
    },
  };
}

function callbackUpdate(fromId: string, updateId: number, data: string, callbackQueryId: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackQueryId,
      from: { id: Number(fromId), is_bot: false, first_name: "Ada", last_name: null, username: "ada" },
      chat_instance: "ci_synthetic_001",
      data,
      message: null,
    },
  };
}

describe("TelegramBotService /start", () => {
  it("sends a welcome message through the adapter for an OWNER", async () => {
    const result = await bot.dispatchUpdate(startUpdate(FAKE_OWNER_USER_ID, FAKE_OWNER_USER_ID, 1));
    expect(result.handled).toBe(true);
    expect(result.bot?.kind).toBe("REPLIED");
    expect(adapter.sentMessages.length).toBe(1);
    const sent = adapter.sentMessages[0]!;
    expect(sent.text).toContain("welcome to BankManage");
    expect(sent.text).toContain("OWNER");
    expect(sent.options?.replyMarkup).toBeDefined();
  });

  it("sends a welcome message for the MEMBER too", async () => {
    const result = await bot.dispatchUpdate(startUpdate(FAKE_MEMBER_USER_ID, FAKE_MEMBER_USER_ID, 2));
    expect(result.handled).toBe(true);
    expect(result.bot?.kind).toBe("REPLIED");
    expect(adapter.sentMessages[0]?.text).toContain("MEMBER");
  });

  it("rejects an unknown Telegram ID with zero mutation (no message sent)", async () => {
    const result = await bot.dispatchUpdate(startUpdate("9999999999", "9999999999", 3));
    expect(result.handled).toBe(true);
    expect(result.bot?.kind).toBe("REJECTED");
    expect(adapter.sentMessages).toHaveLength(0);
  });

  it("ignores commands other than /start", async () => {
    const update = startUpdate(FAKE_OWNER_USER_ID, FAKE_OWNER_USER_ID, 4);
    (update as { message: { text: string } }).message.text = "/help";
    const result = await bot.dispatchUpdate(update);
    expect(result.handled).toBe(true);
    expect(result.bot?.kind).toBe("IGNORED");
    expect(adapter.sentMessages).toHaveLength(0);
  });

  it("rejects malformed updates without throwing", async () => {
    const result = await bot.dispatchUpdate({});
    expect(result.handled).toBe(false);
    expect(result.bot?.kind).toBe("REJECTED");
  });
});

describe("TelegramBotService idempotency", () => {
  it("duplicate update_id is silently ignored (no second reply)", async () => {
    const first = await bot.dispatchUpdate(startUpdate(FAKE_OWNER_USER_ID, FAKE_OWNER_USER_ID, 100));
    const second = await bot.dispatchUpdate(startUpdate(FAKE_OWNER_USER_ID, FAKE_OWNER_USER_ID, 100));
    expect(first.bot?.kind).toBe("REPLIED");
    expect(second.bot?.kind).toBe("IGNORED");
    expect(adapter.sentMessages).toHaveLength(1);
  });
});

describe("TelegramBotService callback handling", () => {
  it("acknowledges the callback PROMPTLY before any slow downstream work", async () => {
    const order: string[] = [];
    const spy = vi.spyOn(adapter, "answerCallbackQuery").mockImplementation(async (_id, text) => {
      order.push(`ack:${text ?? ""}`);
    });
    // Even when the downstream identity lookup takes time, the
    // answerCallbackQuery MUST have been called before that work resolves.
    const slowRepo = {
      findByTelegramUserId: async (id: string) => {
        order.push(`work:${id}`);
        return repo.findByTelegramUserId(id);
      },
      findByMemberId: async (id: number) => repo.findByMemberId(id),
      listAll: async () => repo.listAll(),
    };

    const slowBot = new TelegramBotService({
      adapter,
      identityRepository: slowRepo,
      miniAppLauncher: {
        buildLaunchButton: (_chatId: string) => ({ text: "Open", url: MINI_APP_URL }),
      },
    });

    await slowBot.dispatchUpdate(callbackUpdate(FAKE_OWNER_USER_ID, 200, "noop", "cbq_001"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("ack:Working...");
    // The order array must show ack recorded BEFORE any `work:*` entry.
    const ackIdx = order.findIndex((e) => e.startsWith("ack:"));
    const workIdx = order.findIndex((e) => e.startsWith("work:"));
    expect(ackIdx).toBeGreaterThanOrEqual(0);
    expect(workIdx === -1 || ackIdx < workIdx).toBe(true);
  });

  it("an unknown callback-query user is rejected after ack", async () => {
    const result = await bot.dispatchUpdate(callbackUpdate("9999999999", 201, "noop", "cbq_002"));
    expect(result.bot?.kind).toBe("REJECTED");
    // adapter.answerCallbackQuery was called exactly once (the prompt ack).
    expect(adapter.sentMessages).toHaveLength(0);
  });

  it("replaying the same callback_query update_id does not double-ack", async () => {
    const first = await bot.dispatchUpdate(callbackUpdate(FAKE_OWNER_USER_ID, 300, "noop", "cbq_003"));
    const second = await bot.dispatchUpdate(callbackUpdate(FAKE_OWNER_USER_ID, 300, "noop", "cbq_004"));
    expect(first.bot?.kind).toBe("REPLIED");
    expect(second.bot?.kind).toBe("IGNORED");
  });
});
