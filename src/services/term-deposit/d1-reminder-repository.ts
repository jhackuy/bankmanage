/**
 * D1 implementation of the reminder repository.
 *
 * All SQL is parameterized. No raw D1 binding escapes this module — the
 * application service sees only the abstract `ReminderRepository` port.
 *
 * Row mapping returns the reminder record directly. The TypeScript row type
 * guarantees the numeric columns are numbers; SQLite INTEGER storage keeps
 * them lossless. No arithmetic happens here.
 */

import type { D1Database } from "../../adapters/d1/types.js";
import type { ReminderOffsetKind, ReminderRecord, ReminderStatus } from "../../domain/term-deposit/index.js";
import type { EnsureReminderResult, ReminderClaim, ReminderRepository } from "./reminder-repository.js";

/**
 * Conservative lease timeout for the atomic delivery claim. A claim older
 * than this window is considered abandoned (Worker crash / termination)
 * and becomes reclaimable by a later cron tick. The value is comfortably
 * above the Telegram Bot API request timeout (≈30 s) plus a safety
 * margin for the Cloudflare scheduled handler CPU time, so a slow but
 * live Worker is never starved of its own claim.
 */
const CLAIM_LEASE_TIMEOUT_SECONDS = 90;

/**
 * Generate an opaque ownership token for a new delivery claim. The token
 * is 32 hex chars (128 bits) of CSPRNG entropy from the Web Crypto API,
 * which is available in both Cloudflare Workers and the vitest Node
 * runtime. The token is never logged or returned to the Telegram user.
 */
function generateClaimToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// ── Row type as stored in SQLite ────────────────────────────────────────────

interface ReminderRow {
  id: number;
  deposit_id: number;
  offset_kind: string;
  target_date: string;
  status: string;
  muted_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  claimed_at: string | null;
  claim_token: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    depositId: row.deposit_id,
    offsetKind: row.offset_kind as ReminderOffsetKind,
    targetDate: row.target_date,
    status: row.status as ReminderStatus,
    mutedAt: row.muted_at,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
    claimedAt: row.claimed_at,
    claimToken: row.claim_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── D1 Reminder Repository ──────────────────────────────────────────────────

export class D1ReminderRepository implements ReminderRepository {
  constructor(private readonly db: D1Database) {}

  async ensureReminder(
    depositId: number,
    offsetKind: ReminderOffsetKind,
    targetDate: string
  ): Promise<EnsureReminderResult> {
    // INSERT OR IGNORE then SELECT — the race-safe idempotency boundary.
    // SQLite's INSERT OR IGNORE on the UNIQUE (deposit_id, offset_kind)
    // constraint leaves a duplicate attempt as a no-op, so the subsequent
    // SELECT always returns exactly one row.
    const write = await this.db
      .prepare(
        `INSERT OR IGNORE INTO term_deposit_reminders
           (deposit_id, offset_kind, target_date)
         VALUES (?, ?, ?)`
      )
      .bind(depositId, offsetKind, targetDate)
      .run();
    // `created` is derived from the WRITE result: the UNIQUE constraint makes
    // changes=1 mean "this statement inserted the row" and changes=0 mean
    // "another writer already owns it". A pre-read cannot give this answer
    // because a concurrent scanner may insert between read and write.
    const created = (write.meta.changes ?? 0) > 0;
    const row = await this.db
      .prepare(
        `SELECT * FROM term_deposit_reminders
         WHERE deposit_id = ? AND offset_kind = ?`
      )
      .bind(depositId, offsetKind)
      .first<ReminderRow>();
    if (row === null) {
      // Should be unreachable: UNIQUE constraint guarantees the row exists
      // after INSERT OR IGNORE, but we surface a typed failure rather than
      // throw to keep the service-layer error path uniform.
      throw new Error(
        `ensureReminder: row missing after INSERT OR IGNORE for deposit=${depositId} offset=${offsetKind}`
      );
    }
    return { record: rowToRecord(row), created };
  }

  async listByDeposit(depositId: number): Promise<ReminderRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM term_deposit_reminders
         WHERE deposit_id = ?
         ORDER BY target_date ASC, id ASC`
      )
      .bind(depositId)
      .all<ReminderRow>();
    return result.results.map(rowToRecord);
  }

  async listDueReminders(fromDate: string, toDate: string): Promise<ReminderRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM term_deposit_reminders
         WHERE target_date >= ? AND target_date <= ?
         ORDER BY target_date ASC, deposit_id ASC, offset_kind ASC`
      )
      .bind(fromDate, toDate)
      .all<ReminderRow>();
    return result.results.map(rowToRecord);
  }

  async listPendingForDeposit(depositId: number): Promise<ReminderRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM term_deposit_reminders
         WHERE deposit_id = ? AND status = 'PENDING'
         ORDER BY target_date ASC, id ASC`
      )
      .bind(depositId)
      .all<ReminderRow>();
    return result.results.map(rowToRecord);
  }

  async findById(id: number): Promise<ReminderRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM term_deposit_reminders WHERE id = ?`)
      .bind(id)
      .first<ReminderRow>();
    return row === null ? null : rowToRecord(row);
  }

  async markMutedForDeposit(depositId: number): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE term_deposit_reminders
         SET status = 'MUTED',
             muted_at = datetime('now', 'utc'),
             updated_at = datetime('now', 'utc')
         WHERE deposit_id = ? AND status = 'PENDING'`
      )
      .bind(depositId)
      .run();
    return result.meta.changes ?? 0;
  }

  async markDelivered(id: number, token: string): Promise<ReminderRecord | null> {
    // SPEC §5 finalize-DELIVERED boundary: the row MUST still be PENDING
    // and MUST hold a delivery claim whose token matches the caller's.
    // An old claimant whose lease has since been recovered cannot finalize
    // a replacement claim — the WHERE clause requires `claim_token = ?`,
    // so a wrong or stale token affects 0 rows.
    const row = await this.db
      .prepare(
        `UPDATE term_deposit_reminders
         SET status = 'DELIVERED',
             delivered_at = datetime('now', 'utc'),
             claimed_at = NULL,
             claim_token = NULL,
             updated_at = datetime('now', 'utc')
         WHERE id = ? AND status = 'PENDING' AND claim_token = ?
         RETURNING *`
      )
      .bind(id, token)
      .first<ReminderRow>();
    return row === null ? null : rowToRecord(row);
  }

  async claimForDelivery(id: number): Promise<ReminderClaim | null> {
    // Generate the opaque ownership token. The token is returned to the
    // caller and is required by markDelivered / releaseClaim to take
    // effect. An old claimant cannot finalize or clear a replacement
    // claim because the new claimant's token is different.
    const token = generateClaimToken();
    // Atomic compare-and-set with lease recovery: only one concurrent
    // caller observes changes=1. The WHERE clause accepts a PENDING row
    // whose claim slot is empty OR whose previous claim has expired
    // beyond CLAIM_LEASE_TIMEOUT_SECONDS. A row already in flight (a
    // fresh, non-expired claim) is never re-claimed, and a Worker crash
    // is recovered automatically on the next cron tick.
    const result = await this.db
      .prepare(
        `UPDATE term_deposit_reminders
         SET claimed_at = datetime('now', 'utc'),
             claim_token = ?,
             updated_at = datetime('now', 'utc')
         WHERE id = ? AND status = 'PENDING' AND (
           claimed_at IS NULL OR
           claimed_at < datetime('now', '-${CLAIM_LEASE_TIMEOUT_SECONDS} seconds', 'utc')
         )`
      )
      .bind(token, id)
      .run();
    if ((result.meta.changes ?? 0) === 0) {
      return null;
    }
    return { id, token };
  }

  async releaseClaim(id: number, token: string): Promise<boolean> {
    // Release the claim on a definite transport failure so the next tick
    // can retry. The token guard ensures only the current claimant can
    // clear the claim; a stale owner whose lease has been recovered
    // affects 0 rows and the replacement claim is untouched.
    const result = await this.db
      .prepare(
        `UPDATE term_deposit_reminders
         SET claimed_at = NULL,
             claim_token = NULL,
             updated_at = datetime('now', 'utc')
         WHERE id = ? AND claim_token = ? AND status = 'PENDING'`
      )
      .bind(id, token)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async cancelPendingForDeposit(depositId: number): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE term_deposit_reminders
         SET status = 'CANCELLED',
             cancelled_at = datetime('now', 'utc'),
             updated_at = datetime('now', 'utc')
         WHERE deposit_id = ? AND status IN ('PENDING', 'MUTED')`
      )
      .bind(depositId)
      .run();
    return result.meta.changes ?? 0;
  }
}
