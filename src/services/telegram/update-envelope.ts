/**
 * Types for the Telegram Update envelope used by the M4 webhook and bot
 * dispatch layer.
 *
 * Only the subset of fields the bot actually uses is modelled. Unknown
 * fields are intentionally ignored — Telegram adds optional fields over
 * time, and a forward-compatible parser must not throw.
 *
 * No `any` (per CLAUDE.md / AGENTS.md), so all values are typed.
 */

import type { MemberRole } from "../../adapters/telegram/interface.js";

export interface TelegramChatRef {
  readonly id: number;
  readonly type: string;
}

export interface TelegramFromRef {
  readonly id: number;
  readonly isBot: boolean;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly username: string | null;
}

export interface TelegramMessageEntity {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
}

export interface TelegramMessage {
  readonly messageId: number;
  readonly chat: TelegramChatRef;
  readonly from: TelegramFromRef | null;
  readonly date: number;
  readonly text: string;
  readonly entities: readonly TelegramMessageEntity[];
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramFromRef;
  readonly chatInstance: string;
  readonly data: string;
  readonly message: TelegramMessage | null;
}

export interface TelegramUpdateEnvelope {
  readonly updateId: number;
  readonly message: TelegramMessage | null;
  readonly callbackQuery: TelegramCallbackQuery | null;
}

/**
 * Resolved identity as seen by the webhook handler. The bot handler
 * receives only this — never the raw `from` block, never client-supplied
 * role claims.
 */
export interface VerifiedTelegramUser {
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly memberId: number;
  readonly role: MemberRole;
  readonly displayFirstName: string;
  readonly username: string | null;
}
