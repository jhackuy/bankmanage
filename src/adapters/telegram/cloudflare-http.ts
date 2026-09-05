/**
 * Cloudflare-compatible Telegram adapter implementation.
 *
 * Talks to the Bot HTTP API at `https://api.telegram.org/bot{token}/{method}`.
 * Used by the Worker runtime — never by tests (those use FakeTelegramAdapter).
 *
 * Security:
 *   - The bot token is injected at construction; never logged, never
 *     echoed in error messages.
 *   - Failures throw a typed `TelegramTransportError` with the HTTP
 *     status code only. Response bodies are parsed to confirm the
 *     operation succeeded, but are not re-thrown as text — that could
 *     leak fragments of bot responses.
 *   - `verifyInitData` reuses the platform-neutral verification in
 *     `src/domain/telegram/init-data.ts`. There is no separate "real"
 *     verification path that bypasses the same test-able algorithm.
 */

import { verifyInitData } from "../../domain/telegram/init-data.js";
import type { TelegramAdapter, TelegramIdentity, SendMessageOptions } from "./interface.js";

const BOT_API_BASE = "https://api.telegram.org";

export interface CloudflareTelegramAdapterOptions {
  readonly botToken: string;
  /** Override for tests that need to inject a different fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Max age (seconds) for initData verification. Defaults to 1 hour. */
  readonly initDataMaxAgeSeconds?: number;
  /** "now" override (epoch seconds) for initData verification. */
  readonly nowSeconds?: number;
}

export class TelegramTransportError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TelegramTransportError";
    this.status = status;
  }
}

export class CloudflareTelegramAdapter implements TelegramAdapter {
  private readonly _botToken: string;
  private readonly _fetch: typeof fetch;
  private readonly _maxAgeSeconds: number | undefined;
  private readonly _nowSeconds: number | undefined;

  constructor(opts: CloudflareTelegramAdapterOptions) {
    if (typeof opts.botToken !== "string" || opts.botToken.length === 0) {
      throw new Error("CloudflareTelegramAdapter: botToken must be a non-empty string");
    }
    this._botToken = opts.botToken;
    this._fetch = opts.fetchImpl ?? fetch.bind(globalThis);
    this._maxAgeSeconds = opts.initDataMaxAgeSeconds;
    this._nowSeconds = opts.nowSeconds;
  }

  private endpoint(method: string): string {
    return `${BOT_API_BASE}/bot${this._botToken}/${method}`;
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<{ messageId: number }> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (options?.parseMode !== undefined) body["parse_mode"] = options.parseMode;
    if (options?.replyMarkup !== undefined) body["reply_markup"] = options.replyMarkup;
    if (options?.disableNotification === true) body["disable_notification"] = true;

    const res = await this._fetch(this.endpoint("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new TelegramTransportError(`Telegram sendMessage failed: HTTP ${res.status}`, res.status);
    }
    const json = (await res.json()) as { ok?: boolean; result?: { message_id?: number } };
    if (json.ok !== true || json.result?.message_id === undefined) {
      throw new TelegramTransportError("Telegram sendMessage returned a non-ok payload", res.status);
    }
    return { messageId: json.result.message_id };
  }

  async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (options?.parseMode !== undefined) body["parse_mode"] = options.parseMode;
    if (options?.replyMarkup !== undefined) body["reply_markup"] = options.replyMarkup;

    const res = await this._fetch(this.endpoint("editMessageText"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new TelegramTransportError(`Telegram editMessageText failed: HTTP ${res.status}`, res.status);
    }
    const json = (await res.json()) as { ok?: boolean };
    if (json.ok !== true) {
      throw new TelegramTransportError("Telegram editMessageText returned a non-ok payload", res.status);
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const body: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (typeof text === "string") body["text"] = text;
    if (typeof text === "string" && text.length > 200) {
      // Telegram caps callback_query.text at 200 chars.
      body["text"] = text.slice(0, 200);
    }
    const res = await this._fetch(this.endpoint("answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Callback ack failure is NOT a hard error in the bot service — we
      // still want to log it but allow processing to continue. Surface
      // as a typed error for upstream logging.
      throw new TelegramTransportError(`Telegram answerCallbackQuery failed: HTTP ${res.status}`, res.status);
    }
  }

  /**
   * Cryptographically verifies initData and returns ONLY the Telegram user
   * ID. Role binding MUST be performed by the caller via the
   * `TelegramIdentityRepository` — the role returned here is a placeholder
   * that must NOT be used for authorization decisions.
   *
   * Production callers should use `TelegramMiniAppAuthService` instead,
   * which composes this adapter's HMAC verification with the identity
   * allowlist.
   */
  async verifyInitData(initData: string): Promise<TelegramIdentity> {
    const opts: Parameters<typeof verifyInitData>[2] = {};
    if (this._maxAgeSeconds !== undefined) opts.maxAgeSeconds = this._maxAgeSeconds;
    if (this._nowSeconds !== undefined) opts.nowSeconds = this._nowSeconds;
    const result = await verifyInitData(initData, this._botToken, opts);
    if (!result.ok) {
      throw new Error(`initData verification failed: ${result.code}`);
    }
    // Role is a placeholder; the real role is decided by the identity
    // repository via the TelegramMiniAppAuthService. Encoding a wrong
    // "OWNER" or "MEMBER" here could allow client-side forgery of role.
    return {
      telegramUserId: result.userId,
      role: "MEMBER",
    };
  }
}
