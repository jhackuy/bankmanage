/**
 * tests/unit/telegram-keyboard-contract.test.ts
 *
 * Contract test for the production reminder keyboard.
 *
 * P0 bounded repair: the keyboard MUST NOT advertise callback actions
 * that produce no visible Telegram result. This test enumerates every
 * `callback_data` emitted by `defaultReminderKeyboard` and proves that
 * each one parses to a supported action handled by
 * `TelegramReminderCallbackActions.dispatch` with `producedVisibleResult`
 * === true.
 *
 * If a future change adds a new callback button without a real handler,
 * this test fails — preserving the "no stub actions" invariant.
 */

import { describe, expect, it } from "vitest";
import { defaultReminderKeyboard, REMINDER_ACTIONS } from "../../src/services/telegram/reminder-delivery.js";
import { TelegramReminderCallbackActions } from "../../src/services/telegram/callback-actions.js";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import { FakeTelegramAdapter } from "../../src/adapters/telegram/fake.js";
import { D1ReminderRepository } from "../../src/services/term-deposit/d1-reminder-repository.js";
import { D1TermDepositRepository } from "../../src/services/term-deposit/d1-repository.js";
import { TermDepositReminderService } from "../../src/services/term-deposit/reminder-service.js";

const CALLBACK_PATTERN = /^r:(\d+):([a-z_]+)$/;

function collectCallbackData(markup: {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}): string[] {
  return markup.inline_keyboard.flatMap((row) => row.map((button) => button.callback_data));
}

describe("reminder keyboard — callback contract", () => {
  it("the production keyboard advertises exactly the supported actions (OWNER role)", () => {
    const markup = defaultReminderKeyboard({ reminderId: 1, depositId: 1, role: "OWNER" });
    const dataValues = collectCallbackData(markup);
    expect(dataValues.length).toBeGreaterThan(0);
    for (const data of dataValues) {
      const match = CALLBACK_PATTERN.exec(data);
      expect(match).not.toBeNull();
      const action = match![2]!;
      expect(Object.values(REMINDER_ACTIONS)).toContain(action);
    }
  });

  it("the production keyboard advertises exactly the supported actions (MEMBER role)", () => {
    const markup = defaultReminderKeyboard({ reminderId: 2, depositId: 2, role: "MEMBER" });
    const dataValues = collectCallbackData(markup);
    expect(dataValues.length).toBeGreaterThan(0);
    for (const data of dataValues) {
      const match = CALLBACK_PATTERN.exec(data);
      expect(match).not.toBeNull();
      const action = match![2]!;
      expect(Object.values(REMINDER_ACTIONS)).toContain(action);
    }
  });

  it("every emitted callback_data is either 'view' or 'mute'", () => {
    for (const role of ["OWNER", "MEMBER"] as const) {
      const markup = defaultReminderKeyboard({ reminderId: 3, depositId: 3, role });
      for (const data of collectCallbackData(markup)) {
        const action = CALLBACK_PATTERN.exec(data)![2]!;
        expect(["view", "mute"]).toContain(action);
      }
    }
  });

  it("OWNER and MEMBER keyboards are identical (no role-gated buttons remain)", () => {
    const owner = collectCallbackData(
      defaultReminderKeyboard({ reminderId: 4, depositId: 4, role: "OWNER" })
    );
    const member = collectCallbackData(
      defaultReminderKeyboard({ reminderId: 4, depositId: 4, role: "MEMBER" })
    );
    expect(new Set(owner)).toEqual(new Set(member));
  });

  it("every emitted callback_data produces a visible result when dispatched", async () => {
    const db = new FakeD1Database();
    try {
      const adapter = new FakeTelegramAdapter();
      const reminderRepo = new D1ReminderRepository(db);
      const depositRepo = new D1TermDepositRepository(db);
      const reminderService = new TermDepositReminderService(reminderRepo, depositRepo);
      const actions = new TelegramReminderCallbackActions({
        adapter,
        reminderRepository: reminderRepo,
        depositRepository: depositRepo,
        reminderService,
      });

      for (const role of ["OWNER", "MEMBER"] as const) {
        const markup = defaultReminderKeyboard({ reminderId: 5, depositId: 5, role });
        for (const data of collectCallbackData(markup)) {
          adapter.clearMessages();
          // The reminder id does not need to exist in the DB for this
          // contract check — the view handler responds with a "not found"
          // message and the mute handler does the same. Either way the
          // dispatch produces a visible result.
          const outcome = await actions.dispatch({
            chatId: "100000000001",
            callbackQueryId: "cbq_contract",
            data,
          });
          expect(outcome.producedVisibleResult).toBe(true);
          expect(adapter.sentMessages.length).toBeGreaterThanOrEqual(1);
        }
      }
    } finally {
      db.close();
    }
  });
});
