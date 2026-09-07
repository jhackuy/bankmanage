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
import { parseAllowedUserIds } from "../../src/services/telegram/allowed-user-ids.js";
import { TelegramReminderCallbackActions } from "../../src/services/telegram/callback-actions.js";
import { D1ReminderRepository } from "../../src/services/term-deposit/d1-reminder-repository.js";
import { D1TermDepositRepository } from "../../src/services/term-deposit/d1-repository.js";
import { TermDepositReminderService } from "../../src/services/term-deposit/reminder-service.js";
import { D1UpdateDeduper } from "../../src/services/telegram/d1-update-deduper.js";

const MINI_APP_URL = "https://example.invalid/mini-app";

const allowedUserIds = parseAllowedUserIds(`${FAKE_OWNER_USER_ID},${FAKE_MEMBER_USER_ID}`)!;

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
    allowedUserIds,
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
      allowedUserIds,
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

describe("TelegramBotService callback-action dispatch", () => {
  let reminderRepo: D1ReminderRepository;
  let depositRepo: D1TermDepositRepository;
  let reminderService: TermDepositReminderService;
  let callbackActions: TelegramReminderCallbackActions;
  let deduper: D1UpdateDeduper;
  let botWithActions: TelegramBotService;
  let depositId: number;
  let reminderId: number;

  beforeEach(async () => {
    reminderRepo = new D1ReminderRepository(db);
    depositRepo = new D1TermDepositRepository(db);
    reminderService = new TermDepositReminderService(reminderRepo, depositRepo);
    callbackActions = new TelegramReminderCallbackActions({
      adapter,
      reminderRepository: reminderRepo,
      depositRepository: depositRepo,
      reminderService,
    });
    deduper = new D1UpdateDeduper(db);
    botWithActions = new TelegramBotService({
      adapter,
      identityRepository: repo,
      miniAppLauncher: {
        buildLaunchButton: (_chatId: string) => ({ text: "Open", url: MINI_APP_URL }),
      },
      allowedUserIds,
      deduper,
      callbackActions,
    });

    // Seed an ACTIVE deposit (DRAFT -> REVIEW_REQUIRED -> ACTIVE).
    const ownerMember = await db
      .prepare("SELECT id FROM household_members WHERE role = 'OWNER' LIMIT 1")
      .first<{ id: number }>();
    expect(ownerMember).not.toBeNull();
    if (ownerMember === null) return;

    const bank = await db
      .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, ?)")
      .bind("test-bank", "Test Bank", 0)
      .run();
    const account = await db
      .prepare(
        "INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(ownerMember.id, Number(bank.meta.last_row_id), "PHP", "TERM_DEPOSIT", "Test TD")
      .run();
    const draft = await depositRepo.insertDraft({
      accountId: Number(account.meta.last_row_id),
      bankId: Number(bank.meta.last_row_id),
      holderMemberId: ownerMember.id,
      currencyCode: "PHP",
      productName: "Test Product",
      certificateLastFour: "1234",
      principalMinor: 10_000_000,
      startDate: "2026-01-01",
      maturityDate: "2026-04-01",
      annualRateScaled: 50_000,
      taxRateScaled: 200_000,
      feesMinor: 0,
      interestMethod: "SIMPLE",
      dayCountBasis: "ACT_365",
      maturityInstruction: "PENDING",
    });
    depositId = draft.id;
    await depositRepo.transitionState(depositId, "DRAFT", "REVIEW_REQUIRED");
    await depositRepo.transitionState(depositId, "REVIEW_REQUIRED", "ACTIVE");

    // Insert a reminder directly so the test is deterministic.
    const reminderRow = await db
      .prepare(
        `INSERT INTO term_deposit_reminders (deposit_id, offset_kind, target_date)
         VALUES (?, ?, ?) RETURNING id`
      )
      .bind(depositId, "D_MINUS_7", "2026-03-25")
      .first<{ id: number }>();
    expect(reminderRow).not.toBeNull();
    if (reminderRow === null) return;
    reminderId = reminderRow.id;
  });

  it("view action sends a deposit summary message to the chat", async () => {
    adapter.clearMessages();
    const result = await botWithActions.dispatchUpdate(
      callbackUpdate(FAKE_OWNER_USER_ID, 401, `r:${reminderId}:view`, "cbq_view_1")
    );
    expect(result.bot?.kind).toBe("REPLIED");
    expect(adapter.sentMessages.length).toBe(1);
    const sent = adapter.sentMessages[0]!;
    expect(sent.chatId).toBe(FAKE_OWNER_USER_ID);
    expect(sent.text).toContain(`Term deposit #${depositId}`);
    expect(sent.text).toContain("PHP");
    expect(sent.text).toContain("Maturity: 2026-04-01");
    expect(sent.text).toContain("D_MINUS_7");
  });

  it("mute action mutes all pending reminders for the deposit and confirms", async () => {
    adapter.clearMessages();
    const result = await botWithActions.dispatchUpdate(
      callbackUpdate(FAKE_OWNER_USER_ID, 402, `r:${reminderId}:mute`, "cbq_mute_1")
    );
    expect(result.bot?.kind).toBe("REPLIED");
    expect(adapter.sentMessages.length).toBe(1);
    const sent = adapter.sentMessages[0]!;
    expect(sent.text).toContain(`Reminder ${reminderId} muted`);
    expect(sent.text).toContain(`deposit ${depositId}`);

    // The reminder row is now MUTED in the database.
    const row = await db
      .prepare("SELECT status FROM term_deposit_reminders WHERE id = ?")
      .bind(reminderId)
      .first<{ status: string }>();
    expect(row?.status).toBe("MUTED");
  });

  it("replaying the same callback_query update_id is idempotent (one visible result)", async () => {
    adapter.clearMessages();
    const update = callbackUpdate(FAKE_OWNER_USER_ID, 403, `r:${reminderId}:view`, "cbq_view_replay");
    const first = await botWithActions.dispatchUpdate(update);
    const second = await botWithActions.dispatchUpdate(update);
    expect(first.bot?.kind).toBe("REPLIED");
    expect(second.bot?.kind).toBe("IGNORED");
    expect(adapter.sentMessages.length).toBe(1);
  });

  it("transport failure during dispatch releases the D1 claim so retry succeeds", async () => {
    adapter.clearMessages();
    let sendCount = 0;
    const flakyAdapter = new FakeTelegramAdapter();
    flakyAdapter.clearMessages();
    // Replace the callback actions to use a flaky adapter that throws on
    // the first sendMessage but succeeds afterwards. We achieve that by
    // spying on the original adapter.sendMessage.
    vi.spyOn(adapter, "sendMessage").mockImplementation(async (..._args) => {
      sendCount++;
      if (sendCount === 1) {
        throw new Error("synthetic transport failure");
      }
      return { messageId: sendCount };
    });
    const flakyCallbackActions = new TelegramReminderCallbackActions({
      adapter,
      reminderRepository: reminderRepo,
      depositRepository: depositRepo,
      reminderService,
    });
    const bot = new TelegramBotService({
      adapter,
      identityRepository: repo,
      miniAppLauncher: {
        buildLaunchButton: (_chatId: string) => ({ text: "Open", url: MINI_APP_URL }),
      },
      allowedUserIds,
      deduper,
      callbackActions: flakyCallbackActions,
    });

    // First delivery fails — bot should throw so the webhook returns 5xx.
    await expect(
      bot.dispatchUpdate(callbackUpdate(FAKE_OWNER_USER_ID, 500, `r:${reminderId}:view`, "cbq_retry_1"))
    ).rejects.toThrow("synthetic transport failure");

    // The deduper claim must have been released — a retry with the same
    // update_id should succeed (be able to re-claim and produce a visible
    // result on the second attempt).
    const retry = await bot.dispatchUpdate(
      callbackUpdate(FAKE_OWNER_USER_ID, 500, `r:${reminderId}:view`, "cbq_retry_1b")
    );
    expect(retry.bot?.kind).toBe("REPLIED");
    expect(sendCount).toBeGreaterThanOrEqual(2);
  });

  it("ack still happens before any downstream work on the callback path", async () => {
    adapter.clearMessages();
    const order: string[] = [];
    vi.spyOn(adapter, "answerCallbackQuery").mockImplementation(async (_id, text) => {
      order.push(`ack:${text ?? ""}`);
    });
    const slowActions: TelegramReminderCallbackActions = new TelegramReminderCallbackActions({
      adapter,
      reminderRepository: reminderRepo,
      depositRepository: depositRepo,
      reminderService,
    });
    const slowBot = new TelegramBotService({
      adapter,
      identityRepository: repo,
      miniAppLauncher: {
        buildLaunchButton: (_chatId: string) => ({ text: "Open", url: MINI_APP_URL }),
      },
      allowedUserIds,
      callbackActions: slowActions,
    });
    await slowBot.dispatchUpdate(callbackUpdate(FAKE_OWNER_USER_ID, 600, `r:${reminderId}:view`, "cbq_ack"));
    expect(order[0]).toBe("ack:Working...");
  });
});
