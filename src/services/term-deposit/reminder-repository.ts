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
   * Mark every PENDING reminder for the deposit as MUTED. The "Mute future"
   * button suppresses all remaining Telegram messages for the deposit, not
   * just one row. Returns the number of rows whose status moved to MUTED.
   * MUTED is a delivery-pause state; it does NOT alter deposit business state.
   */
  markMutedForDeposit(depositId: number): Promise<number>;

  /**
   * Atomically claim a PENDING reminder for outbound Telegram delivery.
   * Returns true if this caller is the one that observed the claim
   * transition (changes=1), false if another worker already holds the
   * claim or the row is no longer PENDING.
   *
   * Race-safe boundary (SPEC §5 "scheduler must be idempotent"): two
   * concurrent Cron invocations that both call claimForDelivery for the
   * same reminder id will see exactly one `true` and one `false`, so
   * duplicate logical delivery is impossible even under overlapping
   * isolates. The caller MUST release the claim (releaseClaim) on a
   * definite transport failure so the next tick can retry; final
   * delivery (markDelivered) must succeed within the same window.
   */
  claimForDelivery(id: number): Promise<boolean>;

  /**
   * Release an outstanding delivery claim so the next cron tick can retry.
   * Only clears `claimed_at`; does NOT change status. Safe to call after a
   * transport failure. Returns true if a claim was released, false if the
   * row had no claim to release.
   */
  releaseClaim(id: number): Promise<boolean>;

  /**
   * Mark a reminder as DELIVERED. The D1 repository persists the status
   * transition only if the row is still PENDING and has an outstanding
   * delivery claim (claimed_at IS NOT NULL) — that is the SPEC §5
   * "finalize DELIVERED only after accepted send" boundary.
   *
   * Returns the updated record, or `null` if the row was concurrently
   * muted/cancelled or no longer held a claim. A null result means the
   * transport message has already been accepted (the row state moved
   * elsewhere); callers do not retry.
   */
  markDelivered(id: number): Promise<ReminderRecord | null>;

  /**
   * Cancel all PENDING/MUTED reminders for a deposit. Returns the number
   * of rows whose status moved to CANCELLED. Used when a deposit
   * transitions to MATURED_ACTION_REQUIRED or a terminal state.
   */
  cancelPendingForDeposit(depositId: number): Promise<number>;
}
