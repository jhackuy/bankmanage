/**
 * Fake Telegram adapter for tests.
 *
 * - No real Bot Token required.
 * - Captures sent messages for test assertions.
 * - verifyInitData: returns a preset identity for known test users,
 *   throws 403-equivalent error for "unauthorized" test input.
 */

import type { SendMessageOptions, TelegramAdapter, TelegramIdentity } from "./interface.js";

export interface FakeSentMessage {
  chatId: string;
  text: string;
  options?: SendMessageOptions | undefined;
  messageId: number;
}

/** Fake initData values used in tests. Must be obviously synthetic. */
export const FAKE_OWNER_INIT_DATA = "fake_initdata_owner_synthetic_test_fixture";
export const FAKE_MEMBER_INIT_DATA = "fake_initdata_member_synthetic_test_fixture";
export const FAKE_UNAUTHORIZED_INIT_DATA = "fake_initdata_unauthorized_unknown_user";

/** Synthetic test Telegram user IDs — not real Telegram IDs. */
export const FAKE_OWNER_USER_ID = "100000000001";
export const FAKE_MEMBER_USER_ID = "100000000002";

const FAKE_IDENTITY_MAP: Record<string, TelegramIdentity> = {
  [FAKE_OWNER_INIT_DATA]: { telegramUserId: FAKE_OWNER_USER_ID, role: "OWNER" },
  [FAKE_MEMBER_INIT_DATA]: { telegramUserId: FAKE_MEMBER_USER_ID, role: "MEMBER" },
};

export class TelegramAuthError extends Error {
  readonly status = 403;
  constructor(message = "Unauthorized Telegram identity") {
    super(message);
    this.name = "TelegramAuthError";
  }
}

export class FakeTelegramAdapter implements TelegramAdapter {
  private _messages: FakeSentMessage[] = [];
  private _nextMessageId = 1;

  async sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<{ messageId: number }> {
    const messageId = this._nextMessageId++;
    const entry: FakeSentMessage = { chatId, text, messageId };
    if (options !== undefined) entry.options = options;
    this._messages.push(entry);
    return { messageId };
  }

  async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    const existing = this._messages.find((m) => m.chatId === chatId && m.messageId === messageId);
    if (existing) {
      existing.text = text;
      if (options !== undefined) existing.options = options;
    }
  }

  async answerCallbackQuery(_callbackQueryId: string, _text?: string): Promise<void> {
    // No-op in fake
  }

  /**
   * Verifies a synthetic test initData string.
   * - Known fake owner/member strings → return identity.
   * - Anything else → throw TelegramAuthError (403).
   *
   * Real HMAC verification is implemented in M4.
   */
  async verifyInitData(initData: string): Promise<TelegramIdentity> {
    const identity = FAKE_IDENTITY_MAP[initData];
    if (!identity) {
      throw new TelegramAuthError("Unknown or unauthorized Telegram identity");
    }
    return identity;
  }

  /** Test helpers */
  get sentMessages(): readonly FakeSentMessage[] {
    return this._messages;
  }

  clearMessages(): void {
    this._messages = [];
    this._nextMessageId = 1;
  }
}
