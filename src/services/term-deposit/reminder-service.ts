/**
 * Term-deposit reminder application service.
 *
 * Platform-neutral orchestration: derives which reminder records should
 * exist from each ACTIVE deposit's maturity_date, persists them
 * idempotently, and exposes the queries/statistics the dashboard and the
 * cron scheduler need. Delivery to Telegram is OUT OF SCOPE.
 *
 * SPEC §5 contracts enforced here:
 *   - "Default term-deposit reminders: D-30, D-7, D-1 and D0."
 *   - "The reminder scheduler must be idempotent."
 *   - "Recover missed reminders after temporary outages without duplicate
 *     logical reminders."
 *   - "Muting Telegram messages never changes the deposit business state."
 *   - "A matured unresolved deposit remains visible as an action item until
 *     the evidence/ledger closure is complete."
 */

import {
  REMINDER_OFFSET_KINDS,
  computeTargetDate,
  type ReminderOffsetKind,
  type ReminderRecord,
} from "../../domain/term-deposit/index.js";
import type { TermDepositRepository } from "./repository.js";
import type { ReminderRepository } from "./reminder-repository.js";
import { fail, ok, type ServiceResult, type TermDepositRecord } from "./types.js";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict UTC calendar validation for external date inputs. Rejects strings
 * that match the ISO layout but do not name a real calendar day (e.g.
 * `2026-99-99`) by round-tripping through `Date.UTC`.
 */
function parseIsoDateUtc(s: string): Date {
  if (typeof s !== "string" || !ISO_DATE_PATTERN.test(s)) {
    throw new Error(`Invalid ISO date (expected YYYY-MM-DD): ${s}`);
  }
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`Invalid calendar date: ${s}`);
  }
  return parsed;
}

function assertValidCalendarDate(date: string, field: string): string | null {
  try {
    parseIsoDateUtc(date);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : `Invalid ${field}: ${date}`;
  }
}

export interface ScanResult {
  readonly scanned: number;
  readonly ensured: ReminderRecord[];
  /**
   * Ids of the reminders this scan actually inserted, taken from the
   * database write result. Safe to hand to a delivery step: a concurrent
   * scanner never reports the same id.
   */
  readonly createdIds: readonly number[];
}

export class TermDepositReminderService {
  constructor(
    private readonly reminderRepo: ReminderRepository,
    private readonly depositRepo: TermDepositRepository
  ) {}

  /**
   * Scan every ACTIVE deposit and ensure the four default reminder records
   * (D-30, D-7, D-1, D0) exist. Idempotent: repeated calls do not create
   * duplicates; the UNIQUE (deposit_id, offset_kind) constraint is the
   * race-safe boundary.
   *
   * `createdIds` contains only the reminders whose INSERT actually wrote a
   * row in THIS call, as reported by the repository write result. No
   * pre-read is performed, so two scanners running concurrently can never
   * both report the same reminder as created (which would double-deliver).
   *
   * Recovery: if the caller is running late (e.g. after a temporary
   * outage), a missing D-30 row is still created — the logical fact
   * "this deposit needs a D-30 reminder" remains true, even if its
   * target_date is already in the past. Downstream queries filter by
   * status to distinguish pending from delivered.
   */
  async scanAll(): Promise<ServiceResult<ScanResult>> {
    const ensured: ReminderRecord[] = [];
    const createdIds: number[] = [];
    let scanned = 0;

    // Iterate every ACTIVE deposit. The repository method returns rows in
    // maturity_date ASC order, so a deposit's D-30 target_date is always
    // derived before its D0 target_date in the same call. That ordering
    // is not required for correctness (each call is independent), but it
    // keeps the result deterministic for diff-based tests.
    const deposits = await this.depositRepo.listAllActiveDeposits();
    for (const deposit of deposits) {
      scanned++;
      for (const offsetKind of REMINDER_OFFSET_KINDS) {
        const targetDate = computeTargetDate(deposit.maturityDate, offsetKind);
        const result = await this.reminderRepo.ensureReminder(deposit.id, offsetKind, targetDate);
        ensured.push(result.record);
        if (result.created) {
          createdIds.push(result.record.id);
        }
      }
    }

    return ok({ scanned, ensured, createdIds });
  }

  /**
   * List reminders whose target_date is in [fromDate, toDate], regardless
   * of status. The caller (cron worker, dashboard) decides what to do with
   * DELIVERED rows — usually they are filtered out before rendering.
   */
  async listDue(fromDate: string, toDate: string): Promise<ServiceResult<ReminderRecord[]>> {
    if (typeof fromDate !== "string" || typeof toDate !== "string") {
      return fail("INVALID_INPUT", "fromDate and toDate must be ISO YYYY-MM-DD strings");
    }
    const fromErr = assertValidCalendarDate(fromDate, "fromDate");
    if (fromErr !== null) return fail("INVALID_INPUT", fromErr);
    const toErr = assertValidCalendarDate(toDate, "toDate");
    if (toErr !== null) return fail("INVALID_INPUT", toErr);
    if (fromDate > toDate) {
      return fail("INVALID_INPUT", "fromDate must not be after toDate");
    }
    return ok(await this.reminderRepo.listDueReminders(fromDate, toDate));
  }

  /**
   * Mute a reminder. Delivery-only effect; the underlying deposit state
   * is NOT touched. The "Mute future" button suppresses ALL remaining
   * Telegram messages for the deposit, not just the targeted reminder.
   * Returns a typed failure if the id does not exist.
   */
  async mute(reminderId: number): Promise<ServiceResult<ReminderRecord>> {
    if (!Number.isSafeInteger(reminderId) || reminderId <= 0) {
      return fail("INVALID_INPUT", "reminderId must be a positive safe integer");
    }
    const record = await this.reminderRepo.findById(reminderId);
    if (record === null) {
      return fail("NOT_FOUND", `reminder ${reminderId} not found`);
    }
    await this.reminderRepo.markMutedForDeposit(record.depositId);
    const updated = await this.reminderRepo.findById(reminderId);
    if (updated === null || updated.status !== "MUTED") {
      return fail(
        "ILLEGAL_TRANSITION",
        `reminder ${reminderId} cannot be muted from status ${record.status}`
      );
    }
    return ok(updated);
  }

  /**
   * Cancel all still-relevant reminders for a deposit. Called when a
   * deposit transitions to MATURED_ACTION_REQUIRED (or a terminal state)
   * so no further delivery is attempted.
   */
  async cancelForDeposit(depositId: number): Promise<ServiceResult<number>> {
    if (!Number.isSafeInteger(depositId) || depositId <= 0) {
      return fail("INVALID_INPUT", "depositId must be a positive safe integer");
    }
    const cancelled = await this.reminderRepo.cancelPendingForDeposit(depositId);
    return ok(cancelled);
  }

  /**
   * List matured deposits that still need an action (closure). Per
   * SPEC §5, a matured unresolved deposit remains visible until the
   * evidence/ledger closure is actually completed.
   */
  async listActionRequiredDeposits(): Promise<ServiceResult<TermDepositRecord[]>> {
    return ok(await this.depositRepo.listMaturedUnresolvedDeposits());
  }

  /**
   * Pure helper: derive the four target dates for a single deposit's
   * maturity_date. Exposed for tests and for callers that need to preview
   * reminders without touching the database.
   */
  static deriveTargetDates(maturityDate: string): Readonly<Record<ReminderOffsetKind, string>> {
    const out = {} as Record<ReminderOffsetKind, string>;
    for (const k of REMINDER_OFFSET_KINDS) {
      out[k] = computeTargetDate(maturityDate, k);
    }
    return out;
  }
}
