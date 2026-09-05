/**
 * Telegram reminder callback-query actions.
 *
 * Implements the user-visible side of button taps from reminder messages.
 * The callback data wire format is `r:{reminderId}:{action}` — see
 * `defaultReminderKeyboard` in `./reminder-delivery.ts` for the producer.
 *
 * SPEC §9: "The Bot must acknowledge callbacks promptly before slow work.
 * Duplicate button taps must not duplicate financial writes."
 *
 * Scope of this slice:
 *   - `view`  → look up the reminder + deposit and send a summary message.
 *   - `mute`  → mute all remaining reminders for the deposit (delivery-only
 *               effect; deposit state is NOT touched).
 *
 * Actions not implemented in this slice (`remind_tomorrow`, `remind_7_days`,
 * `process_maturity`) are silently acknowledged by the bot service without
 * producing a visible result. The keyboard still advertises them so users
 * see a consistent surface; wiring the real handlers is deferred to a later
 * slice per the P0 bounded repair directive.
 */

import type { SendMessageOptions, TelegramAdapter } from "../../adapters/telegram/interface.js";
import type { TermDepositRepository } from "../term-deposit/repository.js";
import type { ReminderRepository } from "../term-deposit/reminder-repository.js";
import type { TermDepositReminderService } from "../term-deposit/reminder-service.js";

/** Callback data shape: `r:{reminderId}:{action}`. */
const CALLBACK_PATTERN = /^r:(\d+):([a-z_]+)$/;

/** The minimum set of actions this slice handles with a real visible result. */
export type SupportedCallbackAction = "view" | "mute";

export interface CallbackActionContext {
  readonly chatId: string;
  readonly callbackQueryId: string;
  readonly data: string;
}

export interface CallbackActionOutcome {
  /**
   * True when this handler produced (or attempted to produce) a visible
   * Telegram message. False means the action was silently acknowledged.
   * The bot service uses this for test assertions only — production
   * behaviour is identical either way (ack was already issued by the
   * caller).
   */
  readonly producedVisibleResult: boolean;
}

export interface ReminderCallbackActions {
  /**
   * Dispatch a parsed callback. Throws on transport failure so the bot
   * service can release the deduper claim and let Telegram retry.
   */
  dispatch(ctx: CallbackActionContext): Promise<CallbackActionOutcome>;
}

export interface TelegramReminderCallbackActionsOptions {
  readonly adapter: TelegramAdapter;
  readonly reminderRepository: ReminderRepository;
  readonly depositRepository: TermDepositRepository;
  readonly reminderService: TermDepositReminderService;
}

export class TelegramReminderCallbackActions implements ReminderCallbackActions {
  private readonly _adapter: TelegramAdapter;
  private readonly _reminders: ReminderRepository;
  private readonly _deposits: TermDepositRepository;
  private readonly _reminderService: TermDepositReminderService;

  constructor(opts: TelegramReminderCallbackActionsOptions) {
    this._adapter = opts.adapter;
    this._reminders = opts.reminderRepository;
    this._deposits = opts.depositRepository;
    this._reminderService = opts.reminderService;
  }

  async dispatch(ctx: CallbackActionContext): Promise<CallbackActionOutcome> {
    const parsed = parseCallbackData(ctx.data);
    if (parsed === null) {
      // Malformed callback data — silently ack (already done by caller).
      return { producedVisibleResult: false };
    }
    switch (parsed.action) {
      case "view":
        await this.handleView(ctx.chatId, parsed.reminderId);
        return { producedVisibleResult: true };
      case "mute":
        await this.handleMute(ctx.chatId, parsed.reminderId);
        return { producedVisibleResult: true };
      default:
        // Deferred actions (remind_tomorrow, remind_7_days, process_maturity).
        // Acknowledge but produce no visible result — the button stays
        // reachable so the keyboard surface stays stable across slices.
        return { producedVisibleResult: false };
    }
  }

  private async handleView(chatId: string, reminderId: number): Promise<void> {
    const reminder = await this._reminders.findById(reminderId);
    if (reminder === null) {
      const text = `Reminder ${reminderId} not found.`;
      await this._adapter.sendMessage(chatId, text);
      return;
    }
    const deposit = await this._deposits.findById(reminder.depositId);
    if (deposit === null) {
      const text = `Reminder ${reminderId} refers to deposit ${reminder.depositId} which is no longer available.`;
      await this._adapter.sendMessage(chatId, text);
      return;
    }
    const principalMajor = (deposit.principalMinor / 100).toFixed(2);
    const text =
      `Term deposit #${deposit.id}\n` +
      `Product: ${deposit.productName}\n` +
      `Principal: ${deposit.currencyCode} ${principalMajor}\n` +
      `Maturity: ${deposit.maturityDate}\n` +
      `Reminder (${reminder.offsetKind}): ${reminder.targetDate} — ${reminder.status}`;
    const options: SendMessageOptions = {};
    await this._adapter.sendMessage(chatId, text, options);
  }

  private async handleMute(chatId: string, reminderId: number): Promise<void> {
    const result = await this._reminderService.mute(reminderId);
    if (!result.ok) {
      const code = result.error.code;
      const reason = result.error.message;
      const text =
        code === "NOT_FOUND"
          ? `Reminder ${reminderId} not found.`
          : `Could not mute reminder ${reminderId}: ${reason}`;
      await this._adapter.sendMessage(chatId, text);
      return;
    }
    const text =
      `Reminder ${reminderId} muted.\n` +
      `All remaining Telegram reminders for deposit ${result.value.depositId} are now suppressed.`;
    await this._adapter.sendMessage(chatId, text);
  }
}

interface ParsedCallbackData {
  readonly reminderId: number;
  readonly action: SupportedCallbackAction | string;
}

function parseCallbackData(data: string): ParsedCallbackData | null {
  const match = CALLBACK_PATTERN.exec(data);
  if (match === null) return null;
  const reminderId = Number(match[1]);
  const action = match[2] ?? "";
  if (!Number.isSafeInteger(reminderId) || reminderId <= 0) return null;
  if (action.length === 0) return null;
  return { reminderId, action };
}
