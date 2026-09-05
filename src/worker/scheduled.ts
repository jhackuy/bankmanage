/**
 * Cloudflare Workers scheduled (cron) handler — outbound Telegram reminders.
 *
 * SPEC.md §5 contract enforced here:
 *   - Reminder truth lives in the M1 reminder/deposit tables; we never
 *     create a parallel model.
 *   - The scheduled handler selects PENDING reminders due on `today` (UTC),
 *     resolves the holder's persisted Telegram identity, and sends through
 *     the production `CloudflareTelegramAdapter`.
 *   - Delivery is marked completed ONLY after a successful transport. A
 *     failed transport leaves the row PENDING for the next tick — that is
 *     the SPEC §5 "safely retryable" boundary.
 *   - Muted reminders are skipped (delivery-pause state) and never touch
 *     the deposit row.
 *
 * Fail-closed contract:
 *   - Missing `TELEGRAM_BOT_TOKEN`            → no delivery, logged, no throw.
 *   - Missing/malformed `TELEGRAM_ALLOWED_USER_IDS` → no delivery, logged.
 *   - Missing DB binding                      → no delivery, logged.
 *
 * The handler does not throw on misconfiguration: a cron tick is not an
 * HTTP request, and a thrown error would only be visible in Cloudflare
 * logs. Logging a structured `telegram-reminder-cron-failed` record is
 * sufficient — the reminder rows remain PENDING and the next cron tick
 * will retry once configuration is repaired.
 */

import { CloudflareTelegramAdapter } from "../adapters/telegram/cloudflare-http.js";
import type { TelegramAdapter } from "../adapters/telegram/interface.js";
import { D1TelegramIdentityRepository } from "../services/telegram/d1-identity-repository.js";
import { D1ReminderRepository } from "../services/term-deposit/d1-reminder-repository.js";
import { D1TermDepositRepository } from "../services/term-deposit/d1-repository.js";
import {
  TelegramReminderDeliveryService,
  type ReminderDeliveryOutcome,
} from "../services/telegram/reminder-delivery.js";
import { readAllowedUserIds } from "../services/telegram/allowed-user-ids.js";
import type { D1Database } from "../adapters/d1/types.js";
import type { Env } from "./env.js";

export interface RunCronOptions {
  readonly env: Env;
  readonly ctx: ExecutionContext;
  /**
   * Injectable clock returning the UTC date string `YYYY-MM-DD` for the
   * cron tick. Defaults to `new Date().toISOString().slice(0, 10)`. Tests
   * override this so they don't depend on wall-clock time.
   */
  readonly today?: () => string;
  /**
   * Injectable adapter factory. Defaults to the production
   * `CloudflareTelegramAdapter`. Tests override this so they don't hit
   * `api.telegram.org` and so they can simulate transport failures.
   */
  readonly buildAdapter?: (botToken: string) => TelegramAdapter;
}

/**
 * Run the outbound Telegram reminder delivery once for the configured
 * `today`. Returns a `ReminderDeliveryOutcome` on success (possibly with
 * zeros if nothing is due) and `null` when the cron is fail-closed for the
 * given env. Callers (the Worker `scheduled` handler, the unit tests) can
 * inspect the return value.
 *
 * The parsed `TELEGRAM_ALLOWED_USER_IDS` allowlist is passed into the
 * delivery service. The service intersects the resolved persisted
 * identity with this exact set before transport so a stale/additional
 * identity outside the managed two-user allowlist can never receive
 * outbound financial reminder data.
 */
export async function runTelegramReminderCron(opts: RunCronOptions): Promise<ReminderDeliveryOutcome | null> {
  const env = opts.env;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (typeof botToken !== "string" || botToken.length === 0) {
    return null;
  }
  const allowedUserIds = readAllowedUserIds(env as unknown as Record<string, unknown>);
  if (allowedUserIds === null) {
    return null;
  }
  const db = env.DB as unknown as D1Database | undefined;
  if (db === undefined || db === null) {
    return null;
  }
  const buildAdapter =
    opts.buildAdapter ?? ((token: string) => new CloudflareTelegramAdapter({ botToken: token }));
  const adapter: TelegramAdapter = buildAdapter(botToken);
  const identityRepository = new D1TelegramIdentityRepository(db);
  const reminderRepository = new D1ReminderRepository(db);
  const depositRepository = new D1TermDepositRepository(db);
  const today = (opts.today ?? utcTodayDate)();
  const delivery = new TelegramReminderDeliveryService({
    adapter,
    reminderRepository,
    depositRepository,
    identities: identityRepository,
    fromDate: today,
    toDate: today,
    allowedUserIds,
  });
  return delivery.deliverDueReminders();
}

/** UTC date string `YYYY-MM-DD`. Used by the cron window. */
export function utcTodayDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Cloudflare Workers `scheduled` handler. Wraps `runTelegramReminderCron`
 * in a fail-closed envelope: misconfiguration logs a structured record
 * and returns without mutating any state. Successful runs log a
 * structured summary.
 *
 * SPEC §5 idempotency: this handler is safe to invoke repeatedly. Repeated
 * cron ticks do not produce duplicate logical delivery because
 * `ReminderRepository.markDelivered` is idempotent on the
 * `status IN ('PENDING', 'MUTED')` boundary.
 */
export async function handleScheduled(
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  try {
    const outcome = await runTelegramReminderCron({ env, ctx });
    if (outcome === null) {
      console.error(
        JSON.stringify({
          msg: "telegram-reminder-cron-skipped",
          reason: "managed_configuration_missing_or_malformed",
        })
      );
      return;
    }
    console.warn(
      JSON.stringify({
        msg: "telegram-reminder-cron",
        outcome,
      })
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: "telegram-reminder-cron-failed",
        error: err instanceof Error ? err.message : "unknown",
      })
    );
  }
}
