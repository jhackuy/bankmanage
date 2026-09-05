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
import type { EnsureReminderResult, ReminderRepository } from "./reminder-repository.js";

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

  async markDelivered(id: number): Promise<ReminderRecord | null> {
    // SPEC §5 finalize-DELIVERED boundary: the row MUST still be PENDING
    // and MUST hold an outstanding delivery claim. claimForDelivery set
    // claimed_at; releaseClaim clears it; transport success must call
    // markDelivered before the next tick's claimForDelivery clears the
    // claim. The combined guard makes it impossible to finalize a row
    // that was never claimed or that another worker has already released.
    const row = await this.db
      .prepare(
        `UPDATE term_deposit_reminders
         SET status = 'DELIVERED',
             delivered_at = datetime('now', 'utc'),
             claimed_at = NULL,
             updated_at = datetime('now', 'utc')
         WHERE id = ? AND status = 'PENDING' AND claimed_at IS NOT NULL
         RETURNING *`
      )
      .bind(id)
      .first<ReminderRow>();
    return row === null ? null : rowToRecord(row);
  }

  async claimForDelivery(id: number): Promise<boolean> {
    // Atomic compare-and-set: only one concurrent caller observes
    // changes=1. The other sees changes=0 and skips the reminder.
    // The WHERE clause requires PENDING AND claimed_at IS NULL so a
    // row already in flight (or already DELIVERED/MUTED/CANCELLED) is
    // never re-claimed.
    const result = await this.db
      .prepare(
        `UPDATE term_deposit_reminders
         SET claimed_at = datetime('now', 'utc'),
             updated_at = datetime('now', 'utc')
         WHERE id = ? AND status = 'PENDING' AND claimed_at IS NULL`
      )
      .bind(id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async releaseClaim(id: number): Promise<boolean> {
    // Release the claim on a definite transport failure so the next tick
    // can retry. Only clears claimed_at; status stays PENDING. Returns
    // true if a claim was actually released, false if there was none.
    const result = await this.db
      .prepare(
        `UPDATE term_deposit_reminders
         SET claimed_at = NULL,
             updated_at = datetime('now', 'utc')
         WHERE id = ? AND claimed_at IS NOT NULL AND status = 'PENDING'`
      )
      .bind(id)
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
