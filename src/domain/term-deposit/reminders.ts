/**
 * Term-deposit reminder domain — platform-neutral types and derivation rules.
 *
 * Implements SPEC.md §5: default offsets D-30, D-7, D-1 and D0 relative to
 * the official maturity_date. NO Hono, NO D1, NO R2, NO Telegram, NO UI.
 *
 * `computeTargetDate` is the single source of truth for deriving the
 * calendar date a reminder should fire on. It is deterministic, uses UTC
 * arithmetic only, and never mutates anything.
 */

const MS_PER_DAY = 86_400_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reminder offsets per SPEC §5. Values are days BEFORE the maturity date;
 * D0 fires on the maturity date itself (offset = 0).
 */
export const REMINDER_OFFSETS: Readonly<Record<ReminderOffsetKind, number>> = {
  D_MINUS_30: 30,
  D_MINUS_7: 7,
  D_MINUS_1: 1,
  D0: 0,
};

/** All allowed reminder offset kinds in fire order (earliest first). */
export const REMINDER_OFFSET_KINDS: readonly ReminderOffsetKind[] = [
  "D_MINUS_30",
  "D_MINUS_7",
  "D_MINUS_1",
  "D0",
];

export type ReminderOffsetKind = "D_MINUS_30" | "D_MINUS_7" | "D_MINUS_1" | "D0";

export type ReminderStatus = "PENDING" | "MUTED" | "DELIVERED" | "CANCELLED";

/** All allowed reminder statuses. */
export const REMINDER_STATUSES: readonly ReminderStatus[] = ["PENDING", "MUTED", "DELIVERED", "CANCELLED"];

/**
 * Logical reminder record. One row per (deposit_id, offset_kind); the UNIQUE
 * constraint on that pair is the idempotency boundary enforced by the D1
 * repository layer.
 */
export interface ReminderRecord {
  readonly id: number;
  readonly depositId: number;
  readonly offsetKind: ReminderOffsetKind;
  readonly targetDate: string;
  readonly status: ReminderStatus;
  readonly mutedAt: string | null;
  readonly deliveredAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Parse a strict ISO 'YYYY-MM-DD' date as UTC midnight. Mirrors the same
 * boundary used by `src/domain/term-deposit/interest.ts` so date arithmetic
 * never observes timezone drift.
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

function formatIsoDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Compute the target calendar date for a reminder of `offsetKind` relative
 * to the deposit's maturity date. Deterministic; uses UTC arithmetic so the
 * result is identical regardless of host timezone.
 *
 * Examples (all UTC):
 *   maturity=2026-04-01, D_MINUS_30 -> 2026-03-02
 *   maturity=2026-04-01, D_MINUS_7  -> 2026-03-25
 *   maturity=2026-04-01, D_MINUS_1  -> 2026-03-31
 *   maturity=2026-04-01, D0         -> 2026-04-01
 *   maturity=2026-03-01, D_MINUS_30 -> 2026-01-30 (crosses month boundary)
 *   maturity=2026-03-01, D_MINUS_7  -> 2026-02-22 (crosses Feb/leap boundary)
 */
export function computeTargetDate(maturityDate: string, offsetKind: ReminderOffsetKind): string {
  const maturity = parseIsoDateUtc(maturityDate);
  const offset = REMINDER_OFFSETS[offsetKind];
  const target = new Date(maturity.getTime() - offset * MS_PER_DAY);
  return formatIsoDateUtc(target);
}

/**
 * True if `today` is on or after `targetDate`. Reminders are "due" once
 * their target date has been reached.
 */
export function isReminderDue(targetDate: string, today: string): boolean {
  // Both inputs are strict ISO YYYY-MM-DD; lexicographic comparison is
  // equivalent to chronological comparison for that format.
  if (!ISO_DATE_PATTERN.test(today)) {
    throw new Error(`Invalid today date (expected YYYY-MM-DD): ${today}`);
  }
  parseIsoDateUtc(targetDate); // throws on malformed input
  return today >= targetDate;
}
