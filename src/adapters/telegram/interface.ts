/**
 * Telegram adapter interface.
 *
 * Isolates Telegram Bot API calls from domain/service code.
 * No real token or chat ID required in tests.
 *
 * See SPEC.md §2, §9 and ADR-001.
 */

/** The two allowed roles. */
export type MemberRole = "OWNER" | "MEMBER";

/**
 * Parsed and validated Telegram initData identity.
 * Fields are server-side verified; never trust client-supplied role.
 */
export interface TelegramIdentity {
  /** Numeric Telegram user ID (as string to avoid JS 64-bit precision issues). */
  readonly telegramUserId: string;
  /** Member role resolved from the allowlist, never from client data. */
  readonly role: MemberRole;
}

export interface SendMessageOptions {
  readonly parseMode?: "HTML" | "MarkdownV2";
  readonly replyMarkup?: unknown;
  readonly disableNotification?: boolean;
}

export interface TelegramAdapter {
  /**
   * Send a text message to a chat.
   * Returns the Telegram message_id on success.
   */
  sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<{ messageId: number }>;

  /**
   * Edit an existing message (e.g. to update a reminder).
   */
  editMessage(chatId: string, messageId: number, text: string, options?: SendMessageOptions): Promise<void>;

  /**
   * Answer a callback query (required to remove the loading spinner after button tap).
   * Must be called promptly — Telegram times out after ~30 s.
   */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;

  /**
   * Verify a Telegram Mini App initData string using HMAC-SHA256.
   *
   * Full verification (M4). In M0 the interface is defined but the fake
   * implementation always returns a test identity or throws for obviously
   * invalid input.
   *
   * @returns The verified identity, or throws if verification fails.
   */
  verifyInitData(initData: string): Promise<TelegramIdentity>;
}
