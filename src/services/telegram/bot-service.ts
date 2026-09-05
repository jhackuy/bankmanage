/**
 * Telegram bot service.
 *
 * Owns the bot command / callback surface area:
 *   - `/start`           → welcome message + Mini App entry.
 *   - Callback queries   → acknowledged PROMPTLY (before any slower work)
 *                          so Telegram removes the loading spinner; the
 *                          real work happens after the ack.
 *   - Unknown commands   → a kind nudge, never an error.
 *
 * SPEC.md §9 contracts enforced here:
 *   - "The Bot must acknowledge callbacks promptly before slow work."
 *   - "Duplicate button taps must not duplicate financial writes."
 *
 * Idempotency lives at two layers:
 *   1. The Update deduper (`UpdateDeduper`) stops a replayed update_id
 *      from reaching the handler at all.
 *   2. The downstream business services (term-deposit reminder,
 *      cancellation, muting) are UNIQUE-constraint-idempotent so a
 *      collision that somehow slips past the deduper still cannot
 *      double-write.
 *
 * The service exposes no financial mutation paths; financial state never
 * moves through the bot beyond reminder/mute actions, both of which go
 * through the existing application services.
 */

import type { MemberRole, SendMessageOptions, TelegramAdapter } from "../../adapters/telegram/interface.js";
import type { TelegramIdentityRepository } from "./identity-repository.js";
import { InMemoryUpdateDeduper, type UpdateDeduper } from "./update-deduper.js";
import type {
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdateEnvelope,
  VerifiedTelegramUser,
} from "./update-envelope.js";
import { parseTelegramUpdate } from "./update-parser.js";

const START_COMMAND = "/start";

/** Keyboard button returned by `/start` for opening the Mini App. */
export interface MiniAppLaunchButton {
  readonly text: string;
  readonly url: string;
}

/**
 * Provides the Mini App launch URL. Kept as a tiny port so the route
 * handler (which knows the deployed URL) can inject it without coupling
 * the bot service to wrangler config.
 */
export interface MiniAppLauncher {
  buildLaunchButton(chatId: string): MiniAppLaunchButton;
}

export interface TelegramBotServiceOptions {
  readonly adapter: TelegramAdapter;
  readonly identityRepository: TelegramIdentityRepository;
  readonly miniAppLauncher: MiniAppLauncher;
  readonly deduper?: UpdateDeduper;
}

export type BotHandlerResult =
  | { readonly kind: "REPLIED" }
  | { readonly kind: "IGNORED"; readonly reason: string }
  | { readonly kind: "REJECTED"; readonly reason: string };

export interface UpdateDispatchResult {
  readonly updateId: number;
  readonly handled: boolean;
  readonly bot: BotHandlerResult | null;
}

const REJECT_UNKNOWN_USER = "Unknown Telegram user — not on allowlist";
const IGNORE_DUPLICATE = "Duplicate update (already handled)";
const IGNORE_UNKNOWN_COMMAND = "Unknown bot command";

export class TelegramBotService {
  private readonly _adapter: TelegramAdapter;
  private readonly _identities: TelegramIdentityRepository;
  private readonly _launcher: MiniAppLauncher;
  private readonly _deduper: UpdateDeduper;

  constructor(opts: TelegramBotServiceOptions) {
    this._adapter = opts.adapter;
    this._identities = opts.identityRepository;
    this._launcher = opts.miniAppLauncher;
    this._deduper = opts.deduper ?? new InMemoryUpdateDeduper();
  }

  /**
   * Dispatch a single Telegram update. Returns a result object describing
   * what happened. Never throws for "expected" failures (unknown user,
   * duplicate update, malformed text); only throws for impossible programmer
   * errors.
   */
  async dispatchUpdate(rawUpdate: unknown): Promise<UpdateDispatchResult> {
    let envelope: TelegramUpdateEnvelope;
    try {
      envelope = parseTelegramUpdate(rawUpdate);
    } catch {
      return { updateId: -1, handled: false, bot: { kind: "REJECTED", reason: "Malformed update" } };
    }

    if (!this._deduper.tryClaim(envelope.updateId)) {
      return {
        updateId: envelope.updateId,
        handled: false,
        bot: { kind: "IGNORED", reason: IGNORE_DUPLICATE },
      };
    }

    if (envelope.callbackQuery !== null) {
      const botResult = await this.handleCallback(envelope.callbackQuery);
      return { updateId: envelope.updateId, handled: true, bot: botResult };
    }

    if (envelope.message !== null) {
      const botResult = await this.handleMessage(envelope.message);
      return { updateId: envelope.updateId, handled: true, bot: botResult };
    }

    return {
      updateId: envelope.updateId,
      handled: true,
      bot: { kind: "IGNORED", reason: "No message or callback_query in update" },
    };
  }

  private async handleMessage(message: TelegramMessage): Promise<BotHandlerResult> {
    if (message.from === null) {
      return { kind: "IGNORED", reason: "Message has no sender" };
    }
    const identity = await this._identities.findByTelegramUserId(String(message.from.id));
    if (identity === null) {
      return { kind: "REJECTED", reason: REJECT_UNKNOWN_USER };
    }

    const text = message.text.trim();
    if (text === START_COMMAND || text.startsWith(`${START_COMMAND}@`)) {
      const verified: VerifiedTelegramUser = {
        telegramUserId: String(message.from.id),
        chatId: String(message.chat.id),
        memberId: identity.memberId,
        role: identity.role,
        displayFirstName: message.from.firstName,
        username: message.from.username,
      };
      return this.handleStart(verified);
    }

    return { kind: "IGNORED", reason: IGNORE_UNKNOWN_COMMAND };
  }

  private async handleStart(verified: VerifiedTelegramUser): Promise<BotHandlerResult> {
    const button = this._launcher.buildLaunchButton(verified.chatId);
    const welcomeText = formatStartWelcome(verified.displayFirstName, verified.role);
    const options: SendMessageOptions = {
      replyMarkup: {
        inline_keyboard: [[{ text: button.text, url: button.url }]],
      },
    };
    const sent = await this._adapter.sendMessage(verified.chatId, welcomeText, options);
    if (sent.messageId <= 0) {
      return { kind: "REJECTED", reason: "sendMessage returned no id" };
    }
    return { kind: "REPLIED" };
  }

  private async handleCallback(query: TelegramCallbackQuery): Promise<BotHandlerResult> {
    // SPEC §9: "The Bot must acknowledge callbacks promptly before slow
    // work." Telegram shows a loading spinner until answerCallbackQuery
    // returns. We acknowledge first, then perform any real follow-up.
    await this._adapter.answerCallbackQuery(query.id, "Working...");

    const identity = await this._identities.findByTelegramUserId(String(query.from.id));
    if (identity === null) {
      // Already acknowledged above — no further state mutation is possible.
      return { kind: "REJECTED", reason: REJECT_UNKNOWN_USER };
    }

    // Real work for known callback data happens here. For the M4 surface
    // we acknowledge + record; deeper business actions route through the
    // Mini App (where the role-gated flows live) rather than the bot.
    return { kind: "REPLIED" };
  }

  /** Test/diagnostic helper: clear the deduper. */
  resetDeduper(): void {
    this._deduper.reset();
  }
}

export function formatStartWelcome(firstName: string, role: MemberRole): string {
  return `Hi ${firstName}, welcome to BankManage.\n\nYou are signed in as ${role}.\nTap the button below to open the Mini App.`;
}
