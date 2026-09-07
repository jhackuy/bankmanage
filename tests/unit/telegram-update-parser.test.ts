/**
 * tests/unit/telegram-update-parser.test.ts
 *
 * Verifies parseTelegramUpdate — the forward-compatible Update parser.
 * Unknown fields are ignored; only the typed shape is returned.
 */

import { describe, expect, it } from "vitest";
import { parseTelegramUpdate, TelegramUpdateParseError } from "../../src/services/telegram/index.js";

describe("parseTelegramUpdate", () => {
  it("parses a message-only Update", () => {
    const raw = {
      update_id: 100,
      message: {
        message_id: 100,
        date: 1700000000,
        chat: { id: 1, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Ada", last_name: null, username: "ada" },
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
        extra_field_we_ignore: true,
      },
    };
    const out = parseTelegramUpdate(raw);
    expect(out.updateId).toBe(100);
    expect(out.message?.text).toBe("/start");
    expect(out.message?.entities.length).toBe(1);
    expect(out.callbackQuery).toBeNull();
  });

  it("parses a callback_query-only Update", () => {
    const raw = {
      update_id: 200,
      callback_query: {
        id: "cbq_001",
        from: { id: 42, is_bot: false, first_name: "Ada" },
        chat_instance: "ci_001",
        data: "r:1:view",
        message: null,
      },
    };
    const out = parseTelegramUpdate(raw);
    expect(out.updateId).toBe(200);
    expect(out.callbackQuery?.data).toBe("r:1:view");
    expect(out.message).toBeNull();
  });

  it("throws TelegramUpdateParseError for non-object roots", () => {
    expect(() => parseTelegramUpdate(null)).toThrow(TelegramUpdateParseError);
    expect(() => parseTelegramUpdate(123)).toThrow(TelegramUpdateParseError);
    expect(() => parseTelegramUpdate("string")).toThrow(TelegramUpdateParseError);
  });

  it("throws TelegramUpdateParseError for missing update_id", () => {
    expect(() => parseTelegramUpdate({})).toThrow(TelegramUpdateParseError);
  });

  it("throws TelegramUpdateParseError for non-numeric update_id", () => {
    expect(() => parseTelegramUpdate({ update_id: "abc" })).toThrow(TelegramUpdateParseError);
  });

  it("accepts an update with only update_id (no message or callback)", () => {
    const out = parseTelegramUpdate({ update_id: 999 });
    expect(out.updateId).toBe(999);
    expect(out.message).toBeNull();
    expect(out.callbackQuery).toBeNull();
  });
});
