/**
 * Term-deposit reminder service tests.
 *
 * Exercises the full reminder service stack through the FakeD1Database.
 * Covers:
 *   - scanAll idempotency (repeated scans do not duplicate)
 *   - scan recovery after temporary outage (no duplicate logical reminders)
 *   - mute leaves deposit state unchanged
 *   - matured unresolved deposits remain in action-required query
 *   - reminder cancellation on deposit maturity
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import {
  D1ReminderRepository,
  D1TermDepositRepository,
  TermDepositApplicationService,
  TermDepositReminderService,
  type CreateDraftInput,
} from "../../src/services/term-deposit/index.js";
import { seedDepositParents, type SeededParents } from "../_helpers/seed.js";

const VALID_DRAFT = (overrides: Partial<CreateDraftInput> = {}): CreateDraftInput => ({
  accountId: 0,
  bankId: 0,
  holderMemberId: 0,
  currencyCode: "PHP",
  productName: "Test TD Product",
  certificateLastFour: "1234",
  principalMinor: 10_000_000,
  startDate: "2026-01-01",
  maturityDate: "2026-04-01",
  annualRateScaled: 50_000,
  taxRateScaled: 200_000,
  feesMinor: 0,
  interestMethod: "SIMPLE",
  dayCountBasis: "ACT_365",
  ...overrides,
});

let db: FakeD1Database;
let service: TermDepositApplicationService;
let reminderService: TermDepositReminderService;
let seeded: SeededParents;

beforeEach(async () => {
  db = new FakeD1Database();
  const repo = new D1TermDepositRepository(db);
  service = new TermDepositApplicationService(repo);
  reminderService = new TermDepositReminderService(new D1ReminderRepository(db), repo);
  seeded = await seedDepositParents(db);
});

afterEach(() => {
  db.close();
});

/** Helper: create + activate a deposit so it is eligible for reminders. */
async function createActiveDeposit(overrides: Partial<CreateDraftInput> = {}): Promise<number> {
  const r = await service.createDraft(
    VALID_DRAFT({
      accountId: seeded.accountId,
      bankId: seeded.bankId,
      holderMemberId: seeded.memberId,
      ...overrides,
    })
  );
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("seed setup failed");
  const id = r.value.record.id;
  await service.submitForReview(id);
  await service.activate(id);
  return id;
}

// ── scanAll idempotency ─────────────────────────────────────────────────────

describe("scanAll idempotency", () => {
  it("a single scan creates exactly 4 reminders per ACTIVE deposit", async () => {
    await createActiveDeposit();
    const scan1 = await reminderService.scanAll();
    expect(scan1.ok).toBe(true);
    if (!scan1.ok) return;
    expect(scan1.value.scanned).toBe(1);
    expect(scan1.value.ensured).toHaveLength(4);
    expect(scan1.value.createdIds).toHaveLength(4);
  });

  it("a repeated scan does NOT create duplicate reminders", async () => {
    await createActiveDeposit();
    const scan1 = await reminderService.scanAll();
    expect(scan1.ok).toBe(true);
    if (!scan1.ok) return;
    const firstIds = [...scan1.value.createdIds].sort((a, b) => a - b);

    const scan2 = await reminderService.scanAll();
    expect(scan2.ok).toBe(true);
    if (!scan2.ok) return;
    expect(scan2.value.scanned).toBe(1);
    expect(scan2.value.ensured).toHaveLength(4);
    expect(scan2.value.createdIds).toHaveLength(0); // no new rows

    // All 4 reminder ids from scan1 are still present.
    const rows = await db.prepare("SELECT id FROM term_deposit_reminders ORDER BY id").all<{ id: number }>();
    expect(rows.results.map((r) => r.id).sort((a, b) => a - b)).toEqual(firstIds);
  });

  it("scanning twice produces the same logical reminder ids for two deposits", async () => {
    const id1 = await createActiveDeposit();
    await createActiveDeposit({
      accountId: seeded.accountId2,
      bankId: seeded.otherBankId,
      currencyCode: "EUR",
    });

    const scan1 = await reminderService.scanAll();
    expect(scan1.ok).toBe(true);
    if (!scan1.ok) return;
    expect(scan1.value.scanned).toBe(2);
    expect(scan1.value.ensured).toHaveLength(8);
    expect(scan1.value.createdIds).toHaveLength(8);

    const scan2 = await reminderService.scanAll();
    expect(scan2.ok).toBe(true);
    if (!scan2.ok) return;
    expect(scan2.value.ensured).toHaveLength(8);
    expect(scan2.value.createdIds).toHaveLength(0);

    // Each deposit still has exactly 4 reminders.
    const rows1 = await db
      .prepare("SELECT COUNT(*) as cnt FROM term_deposit_reminders WHERE deposit_id = ?")
      .bind(id1)
      .first<{ cnt: number }>();
    expect(rows1?.cnt).toBe(4);
  });

  it("a scan with no ACTIVE deposits returns scanned=0 and creates nothing", async () => {
    // Create a DRAFT (not ACTIVE).
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(r.ok).toBe(true);

    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.value.scanned).toBe(0);
    expect(scan.value.ensured).toHaveLength(0);
    expect(scan.value.createdIds).toHaveLength(0);
  });

  it("createdIds excludes a reminder row inserted by another writer", async () => {
    // Simulate a concurrent scanner (or an earlier partial scan) that already
    // persisted the D0 reminder for this deposit. Only the three rows this
    // scan actually inserts may appear in createdIds, otherwise a delivery
    // step would double-send the D0 reminder.
    const depositId = await createActiveDeposit({ maturityDate: "2026-04-01" });
    await db
      .prepare(
        `INSERT INTO term_deposit_reminders (deposit_id, offset_kind, target_date)
         VALUES (?, 'D0', '2026-04-01')`
      )
      .bind(depositId)
      .run();
    const preExisting = await db
      .prepare("SELECT id FROM term_deposit_reminders WHERE deposit_id = ? AND offset_kind = 'D0'")
      .bind(depositId)
      .first<{ id: number }>();
    expect(preExisting).not.toBeNull();

    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.value.ensured).toHaveLength(4);
    expect(scan.value.createdIds).toHaveLength(3);
    expect(scan.value.createdIds).not.toContain(preExisting!.id);

    // Still exactly four logical reminders for the deposit.
    const count = await db
      .prepare("SELECT COUNT(*) as cnt FROM term_deposit_reminders WHERE deposit_id = ?")
      .bind(depositId)
      .first<{ cnt: number }>();
    expect(count?.cnt).toBe(4);
  });

  it("ensureReminder reports created=true only for the call that inserted the row", async () => {
    const depositId = await createActiveDeposit({ maturityDate: "2026-04-01" });
    const repo = new D1ReminderRepository(db);

    const first = await repo.ensureReminder(depositId, "D_MINUS_7", "2026-03-25");
    expect(first.created).toBe(true);
    expect(first.record.targetDate).toBe("2026-03-25");

    const second = await repo.ensureReminder(depositId, "D_MINUS_7", "2026-03-25");
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
  });

  it("does not issue a per-offset existing-reminder query", async () => {
    // Guard against reintroducing a pre-read per offset. One deposit needs:
    // 1 deposit listing + (INSERT + SELECT) per offset = 1 + 4*2 = 9
    // prepared statements. Anything above that means extra reads crept back.
    await createActiveDeposit({ maturityDate: "2026-04-01" });
    const before = db.statementCount;
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    expect(db.statementCount - before).toBeLessThanOrEqual(9);
  });
});

// ── scan recovery after outage ─────────────────────────────────────────────

describe("scan recovery after temporary outage", () => {
  it("a late scan still creates the missing D-30 record without duplication", async () => {
    // maturity_date=2026-04-01 → D-30 target = 2026-03-02.
    // Imagine the scanner missed on 2026-03-02 and ran on 2026-03-15 instead.
    await createActiveDeposit();
    const scan1 = await reminderService.scanAll();
    expect(scan1.ok).toBe(true);
    if (!scan1.ok) return;

    // A second scan, conceptually later in time, must not produce new rows
    // for the same deposit. The row created in scan1 already represents the
    // D-30 reminder fact; the late scan simply confirms it.
    const scan2 = await reminderService.scanAll();
    expect(scan2.ok).toBe(true);
    if (!scan2.ok) return;
    expect(scan2.value.createdIds).toHaveLength(0);

    // The D-30 reminder is still queryable, with its original target_date
    // (2026-03-02), even though the "current date" is past it.
    const rows = await db
      .prepare("SELECT target_date FROM term_deposit_reminders " + "WHERE offset_kind = 'D_MINUS_30'")
      .all<{ target_date: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.target_date).toBe("2026-03-02");
  });

  it("two deposits created and scanned independently: each has exactly one of each offset", async () => {
    const id1 = await createActiveDeposit();
    const id2 = await createActiveDeposit({
      accountId: seeded.accountId2,
      bankId: seeded.otherBankId,
      currencyCode: "EUR",
      maturityDate: "2026-07-15",
    });
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.value.createdIds).toHaveLength(8);

    const count1 = await db
      .prepare("SELECT COUNT(*) as cnt FROM term_deposit_reminders WHERE deposit_id = ?")
      .bind(id1)
      .first<{ cnt: number }>();
    expect(count1?.cnt).toBe(4);

    const count2 = await db
      .prepare("SELECT COUNT(*) as cnt FROM term_deposit_reminders WHERE deposit_id = ?")
      .bind(id2)
      .first<{ cnt: number }>();
    expect(count2?.cnt).toBe(4);

    // And a re-scan does not duplicate either.
    const scan2 = await reminderService.scanAll();
    expect(scan2.ok).toBe(true);
    if (!scan2.ok) return;
    expect(scan2.value.createdIds).toHaveLength(0);
  });
});

// ── mute does not alter deposit state ──────────────────────────────────────

describe("mute leaves deposit state unchanged", () => {
  it("muting a reminder does NOT mutate the deposit row", async () => {
    const id = await createActiveDeposit();
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const reminderId = scan.value.createdIds[0];
    expect(reminderId).toBeDefined();

    const before = await service.getDeposit(id);
    expect(before.ok).toBe(true);
    if (!before.ok || before.value === null) throw new Error("deposit missing");

    const muteResult = await reminderService.mute(reminderId!);
    expect(muteResult.ok).toBe(true);
    if (!muteResult.ok) return;
    expect(muteResult.value.status).toBe("MUTED");

    // Deposit state unchanged.
    const after = await service.getDeposit(id);
    expect(after.ok).toBe(true);
    if (!after.ok || after.value === null) throw new Error("deposit missing");
    expect(after.value.record.state).toBe("ACTIVE");
    expect(after.value.record.updatedAt).toBe(before.value.record.updatedAt);
    expect(after.value.record.principalMinor).toBe(before.value.record.principalMinor);
  });

  it("muting an unknown id returns NOT_FOUND", async () => {
    const r = await reminderService.mute(999_999);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NOT_FOUND");
  });

  it("muting a non-positive id returns INVALID_INPUT", async () => {
    const r = await reminderService.mute(0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("muting a delivered reminder is rejected", async () => {
    await createActiveDeposit();
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const reminderId = scan.value.createdIds[0]!;

    // Force-deliver via repository directly (delivery out of scope).
    await new D1ReminderRepository(db).markDelivered(reminderId);

    const r = await reminderService.mute(reminderId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ILLEGAL_TRANSITION");
  });
});

// ── matured unresolved deposits remain in action-required query ───────────

describe("matured unresolved deposits remain actionable", () => {
  it("listActionRequiredDeposits returns deposits in MATURED_ACTION_REQUIRED state", async () => {
    const id = await createActiveDeposit();
    // Promote the deposit to MATURED_ACTION_REQUIRED via the state machine.
    const matured = await service.markMatured(id);
    expect(matured.ok).toBe(true);

    const list = await reminderService.listActionRequiredDeposits();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);
    expect(list.value[0]?.id).toBe(id);
    expect(list.value[0]?.state).toBe("MATURED_ACTION_REQUIRED");
  });

  it("listActionRequiredDeposits excludes ACTIVE deposits", async () => {
    await createActiveDeposit();
    const list = await reminderService.listActionRequiredDeposits();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(0);
  });

  it("listActionRequiredDeposits excludes terminal deposits", async () => {
    // Create a DRAFT, cancel it, and verify it is NOT in the action list.
    const r = await service.createDraft(
      VALID_DRAFT({
        accountId: seeded.accountId,
        bankId: seeded.bankId,
        holderMemberId: seeded.memberId,
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await service.cancelDraft(r.value.record.id);

    const list = await reminderService.listActionRequiredDeposits();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(0);
  });
});

// ── cancelForDeposit ──────────────────────────────────────────────────────

describe("cancelForDeposit", () => {
  it("cancels all PENDING reminders for a deposit", async () => {
    await createActiveDeposit();
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const r = await reminderService.cancelForDeposit(scan.value.ensured[0]!.depositId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(4);

    // Subsequent scan still returns the same logical reminders (now
    // CANCELLED), but creates nothing new.
    const scan2 = await reminderService.scanAll();
    expect(scan2.ok).toBe(true);
    if (!scan2.ok) return;
    expect(scan2.value.createdIds).toHaveLength(0);
    for (const rec of scan2.value.ensured) {
      expect(rec.status).toBe("CANCELLED");
    }
  });

  it("rejects non-positive deposit ids", async () => {
    const r = await reminderService.cancelForDeposit(0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });
});

// ── listDue ──────────────────────────────────────────────────────────────

describe("listDue", () => {
  it("returns reminders whose target_date is within [fromDate, toDate]", async () => {
    const id = await createActiveDeposit({ maturityDate: "2026-04-01" });
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);

    const r = await reminderService.listDue("2026-03-25", "2026-04-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBeGreaterThanOrEqual(3); // D_MINUS_7, D_MINUS_1, D0
    for (const reminder of r.value) {
      expect(reminder.targetDate >= "2026-03-25").toBe(true);
      expect(reminder.targetDate <= "2026-04-01").toBe(true);
      expect(reminder.depositId).toBe(id);
    }
  });

  it("rejects reversed date range", async () => {
    const r = await reminderService.listDue("2026-04-15", "2026-04-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects impossible calendar fromDate (regex-pass but not a real date)", async () => {
    const r = await reminderService.listDue("2026-99-99", "2026-04-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects impossible calendar toDate (regex-pass but not a real date)", async () => {
    const r = await reminderService.listDue("2026-04-01", "2026-02-30");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
  });
});
