/**
 * Term-deposit reminder repository interface.
 *
 * Application services depend on this abstract port. The D1 adapter in
 * `./d1-reminder-repository.ts` provides the production implementation;
 * tests use the same port against the FakeD1Database binding.
 *
 * The repository is responsible for:
 *   - idempotent insertion keyed on (deposit_id, offset_kind);
 *   - deterministic row-to-domain mapping;
 *   - parameterized SQL only;
 *   - no business logic (muting semantics live in the service layer).
 *
 * The repository does NOT:
 *   - decide which deposits need reminders (service iterates deposits);
 *   - compute or override the deterministic maturity estimate;
 *   - perform Telegram delivery (out of M1C scope).
 */

import type { ReminderOffsetKind, ReminderRecord } from "../../domain/term-deposit/index.js";

/**
 * Result of an idempotent reminder upsert.
 *
 * `created` comes from the database WRITE result of this call, not from a
 * prior read. That makes it race-safe: when two scanners ensure the same
 * (deposit_id, offset_kind) concurrently, exactly one of them observes
 * `created: true`, so downstream delivery can never be triggered twice for
 * the same logical reminder.
 */
export interface EnsureReminderResult {
  readonly record: ReminderRecord;
  readonly created: boolean;
}

export interface ReminderRepository {
  /**
   * Idempotently ensure a reminder row exists for (depositId, offsetKind)
   * with the given targetDate. If a row already exists, it is returned
   * unchanged with `created: false`; if not, it is inserted in PENDING
   * status and returned with `created: true`.
   *
   * The UNIQUE (deposit_id, offset_kind) constraint is the race-safe
   * boundary: concurrent scans cannot create duplicates, and only the
   * caller whose INSERT actually wrote the row sees `created: true`.
   */
  ensureReminder(
    depositId: number,
    offsetKind: ReminderOffsetKind,
    targetDate: string
  ): Promise<EnsureReminderResult>;

  /** SELECT all reminders for a deposit, ordered by target_date ASC. */
  listByDeposit(depositId: number): Promise<ReminderRecord[]>;

  /** SELECT reminders whose target_date is within [fromDate, toDate]. */
  listDueReminders(fromDate: string, toDate: string): Promise<ReminderRecord[]>;

  /** SELECT reminders that have not yet been delivered/muted/cancelled. */
  listPendingForDeposit(depositId: number): Promise<ReminderRecord[]>;

  /** SELECT a single reminder by id. Returns null if no row matches. */
  findById(id: number): Promise<ReminderRecord | null>;

  /**
   * Mark a PENDING reminder as MUTED. Returns the updated row. MUTED is a
   * delivery-pause state; it does NOT alter deposit business state. Returns
   * null if the id does not exist or is no longer PENDING.
   */
  markMuted(id: number): Promise<ReminderRecord | null>;

  /**
   * Mark a reminder as DELIVERED. Delivery is out of M1C scope; the D1
   * repository only persists the status transition.
   */
  markDelivered(id: number): Promise<ReminderRecord | null>;

  /**
   * Cancel all PENDING/MUTED reminders for a deposit. Returns the number
   * of rows whose status moved to CANCELLED. Used when a deposit
   * transitions to MATURED_ACTION_REQUIRED or a terminal state.
   */
  cancelPendingForDeposit(depositId: number): Promise<number>;
}
