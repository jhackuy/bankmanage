/**
 * Telegram reminder delivery.
 *
 * SPEC.md §5 contracts enforced here:
 *   - "Muting Telegram messages never changes the deposit business state."
 *   - The reminder scheduler is idempotent.
 *   - "Recover missed reminders after temporary outages without duplicate
 *      logical reminders."
 *   - A failed Telegram delivery must NOT fabricate a completed reminder
 *     (or financial action). The reminder row stays PENDING.
 *
 * Architecture: this service is platform-neutral. It calls the existing
 * `ReminderRepository` and `TermDepositRepository` for truth and the
 * `TelegramAdapter` for transport. The Cloudflare Worker puts both behind
 * a cron-trigger handler that decides *when* to run; the worker never
 * mutates deposit state directly.
 */

import type { SendMessageOptions, TelegramAdapter, MemberRole } from "../../adapters/telegram/interface.js";
import type { ReminderRecord } from "../../domain/term-deposit/index.js";
import type { TermDepositRepository } from "../term-deposit/repository.js";
import type { ReminderRepository } from "../term-deposit/reminder-repository.js";
import type { TelegramIdentityRepository, ResolvedTelegramIdentity } from "./identity-repository.js";
import type { AllowedUserIds } from "./allowed-user-ids.js";

export interface ReminderDeliveryOutcome {
  readonly attempted: number;
  readonly delivered: number;
  readonly skippedMuted: number;
  readonly failed: number;
  readonly errors: readonly string[];
}

export interface TelegramReminderDeliveryServiceOptions {
  readonly adapter: TelegramAdapter;
  readonly reminderRepository: ReminderRepository;
  readonly depositRepository: TermDepositRepository;
  readonly identities: TelegramIdentityRepository;
  /** Inclusive lower bound for the target_date window. */
  readonly fromDate: string;
  /** Inclusive upper bound for the target_date window (the cron "today"). */
  readonly toDate: string;
  /**
   * Exact managed allowlist of Telegram user IDs permitted to receive
   * outbound financial reminders. When supplied, the service intersects
   * the resolved persisted identity with this set before sending. A
   * persisted identity outside the allowlist is treated as "no safe
   * recipient" and the reminder is skipped (not sent, not finalized).
   */
  readonly allowedUserIds?: AllowedUserIds;
  /** Build the inline keyboard for a given reminder. Defaults to SPEC §5. */
  readonly buildKeyboard?: (params: BuildKeyboardParams) => SendMessageOptions["replyMarkup"];
}

export interface BuildKeyboardParams {
  readonly reminderId: number;
  readonly depositId: number;
  readonly role: MemberRole;
}

const ACTION_VIEW = "view";
const ACTION_MUTE = "mute";

export const REMINDER_ACTIONS = {
  view: ACTION_VIEW,
  mute: ACTION_MUTE,
} as const;

export class TelegramReminderDeliveryService {
  private readonly _adapter: TelegramAdapter;
  private readonly _reminders: ReminderRepository;
  private readonly _deposits: TermDepositRepository;
  private readonly _identities: TelegramIdentityRepository;
  private readonly _fromDate: string;
  private readonly _toDate: string;
  private readonly _allowedUserIds: AllowedUserIds | undefined;
  private readonly _buildKeyboard: NonNullable<TelegramReminderDeliveryServiceOptions["buildKeyboard"]>;

  constructor(opts: TelegramReminderDeliveryServiceOptions) {
    this._adapter = opts.adapter;
    this._reminders = opts.reminderRepository;
    this._deposits = opts.depositRepository;
    this._identities = opts.identities;
    this._fromDate = opts.fromDate;
    this._toDate = opts.toDate;
    this._allowedUserIds = opts.allowedUserIds;
    this._buildKeyboard =
      opts.buildKeyboard ??
      ((params) =>
        defaultReminderKeyboard({
          reminderId: params.reminderId,
          depositId: params.depositId,
          role: params.role,
        }));
  }

  /**
   * Deliver every PENDING reminder whose target_date is within [fromDate, toDate].
   *
   * SPEC §5 contracts enforced here:
   *   - Reminder truth comes from the M1 reminder repository (not from
   *     Telegram observations). The service never touches deposit state
   *     directly. Muting is a separate path through TermDepositReminderService.
   *   - "Recover missed reminders without duplicate logical reminders" — the
   *     atomic claim/release boundary guarantees that two concurrent Cron
   *     invocations cannot both send the same logical reminder.
   *   - "Only the two household members (OWNER + MEMBER) may interact
   *     with the bot" — the resolved persisted identity is intersected
   *     with the exact managed allowlist before transport.
   *
   * Failure isolation: a failing transport for one reminder never blocks
   * delivery of the others. A failing row releases its claim (back to
   * PENDING with claimed_at = NULL) so it can be retried on the next scan.
   */
  async deliverDueReminders(): Promise<ReminderDeliveryOutcome> {
    const all = await this._reminders.listDueReminders(this._fromDate, this._toDate);
    const pending = all.filter((r) => r.status === "PENDING" || r.status === "MUTED");

    let delivered = 0;
    let skippedMuted = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const reminder of pending) {
      if (reminder.status === "MUTED") {
        skippedMuted++;
        continue;
      }
      try {
        const sent = await this.deliverOne(reminder);
        if (sent) delivered++;
        else failed++;
      } catch (err) {
        failed++;
        errors.push(
          `reminder ${reminder.id}: ${err instanceof Error ? err.message : "unknown transport error"}`
        );
      }
    }

    return {
      attempted: pending.length,
      delivered,
      skippedMuted,
      failed,
      errors,
    };
  }

  private async deliverOne(reminder: ReminderRecord): Promise<boolean> {
    // Race-safe delivery claim with lease recovery + ownership token
    // (migrations 0015 + 0016). claimForDelivery atomically transitions
    // PENDING + (claimed_at IS NULL OR lease expired) → PENDING +
    // claimed_at = now + claim_token = newToken. Two concurrent Cron
    // invocations both calling this for the same id will see exactly
    // one non-null claim and one null; the loser skips without touching
    // the transport adapter. The returned token is required by
    // markDelivered / releaseClaim to prove the caller still owns the
    // claim, so a stale claimant cannot finalize or clear a
    // replacement claim.
    const claim = await this._reminders.claimForDelivery(reminder.id);
    if (claim === null) {
      // Another worker holds a non-expired claim (or the row is no
      // longer PENDING). This is the SPEC §5 "duplicate logical
      // delivery is impossible" boundary. Skip silently.
      return false;
    }

    try {
      // Find who owns the deposit (household member).
      const deposits = await this._deposits.listAllActiveDeposits();
      const deposit = deposits.find((d) => d.id === reminder.depositId);
      if (deposit === undefined) {
        // The reminder refers to a deposit that is no longer ACTIVE (e.g.
        // CANCELLED or terminal). Release the claim so the next tick can
        // see whatever the current row state is; the row itself is
        // unchanged.
        await this._reminders.releaseClaim(reminder.id, claim.token);
        return false;
      }
      const holderId = deposit.holderMemberId;

      // Resolve holder to a Telegram identity. The repository may return
      // a persisted identity whose Telegram user ID is no longer in the
      // exact managed allowlist (e.g. a stale row from before the
      // allowlist shrank). Intersect here: the service MUST NOT send
      // outbound financial reminder data to anyone outside the
      // configured two-user allowlist.
      const identity = await this.findIdentityForMember(holderId);
      if (identity === null) {
        await this._reminders.releaseClaim(reminder.id, claim.token);
        return false;
      }
      const chatId = identity.telegramUserId;

      const text = formatReminderText(reminder.depositId, reminder.offsetKind, reminder.targetDate);
      const replyMarkup = this._buildKeyboard({
        reminderId: reminder.id,
        depositId: reminder.depositId,
        role: identity.role,
      });
      const result = await this._adapter.sendMessage(chatId, text, { replyMarkup });
      if (result.messageId <= 0) {
        // Transport returned a non-positive messageId — treat as a
        // failure, release the claim so the next tick retries.
        await this._reminders.releaseClaim(reminder.id, claim.token);
        return false;
      }
      // Finalize DELIVERED only after the transport accepted the
      // message. markDelivered requires the row to still be PENDING and
      // its claim_token to match ours; the combined guard makes a
      // duplicate finalize impossible even if another worker raced us
      // (and prevents a slow claimant whose lease has been recovered
      // from finalizing a replacement claim).
      const updated = await this._reminders.markDelivered(reminder.id, claim.token);
      if (updated === null) {
        // The row was concurrently muted/cancelled after our send, or
        // our lease was recovered before markDelivered ran. The message
        // has already been accepted by Telegram; we do not retry and we
        // do not roll back the deposit business state.
        return true;
      }
      return true;
    } catch (err) {
      // Transport or DB failure: release the claim so the next cron
      // tick retries. The row stays PENDING (SPEC §5 safely-retryable
      // boundary) and the deposit row is NEVER mutated from this
      // service. Passing our token ensures we only release our own
      // claim — if the lease has already been recovered by another
      // worker, releaseClaim affects 0 rows and the replacement claim
      // is left intact.
      await this._reminders.releaseClaim(reminder.id, claim.token);
      throw err;
    }
  }

  /**
   * Find the Telegram identity for a household member. When the
   * configured managed allowlist is present, the resolved identity's
   * Telegram user ID must be a member of that exact set; otherwise
   * this returns null and the reminder is skipped.
   *
   * The pilot allowlist is exactly two IDs (OWNER + MEMBER). A stale
   * persisted identity outside that set is a managed-config drift; the
   * service treats it as "no safe recipient" rather than risk sending
   * outbound financial reminder data to an unintended Telegram user.
   */
  private async findIdentityForMember(memberId: number): Promise<ResolvedTelegramIdentity | null> {
    // Pull every active identity once. The pilot is exactly two users,
    // so this is cheaper and simpler than a reverse-index SQL round trip.
    const all = await this._identities.listAll();
    const match = all.find((i) => i.memberId === memberId);
    if (match === undefined) return null;
    if (this._allowedUserIds !== undefined && !this._allowedUserIds.ids.has(match.telegramUserId)) {
      return null;
    }
    return match;
  }
}

export function defaultReminderKeyboard(params: {
  reminderId: number;
  depositId: number;
  role: MemberRole;
}): SendMessageOptions["replyMarkup"] {
  const data = (action: string): string => `r:${params.reminderId}:${action}`;
  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: "View deposit", callback_data: data(ACTION_VIEW) }],
    [{ text: "Mute future", callback_data: data(ACTION_MUTE) }],
  ];
  return { inline_keyboard };
}

export function formatReminderText(depositId: number, offsetKind: string, targetDate: string): string {
  return (
    `Term deposit #${depositId}: maturity reminder (${offsetKind}).\n` +
    `Target date: ${targetDate}.\n` +
    `Open the Mini App to review and process this maturity.`
  );
}
