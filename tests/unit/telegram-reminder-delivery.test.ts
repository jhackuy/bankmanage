/**
 * tests/unit/telegram-reminder-delivery.test.ts
 *
 * Verifies TelegramReminderDeliveryService:
 *   - sends pending reminders through the production Bot adapter path;
 *   - marks reminders delivered ONLY after a successful transport;
 *   - muting a reminder does NOT alter the deposit business state;
 *   - a transport failure does NOT fabricate a "completed" reminder.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import { FakeTelegramAdapter } from "../../src/adapters/telegram/fake.js";
import { D1TelegramIdentityRepository } from "../../src/services/telegram/d1-identity-repository.js";
import {
  D1ReminderRepository,
  D1TermDepositRepository,
  TermDepositApplicationService,
  TermDepositReminderService,
  type CreateDraftInput,
} from "../../src/services/term-deposit/index.js";
import { TelegramReminderDeliveryService } from "../../src/services/telegram/reminder-delivery.js";
import { seedDepositParents, type SeededParents } from "../_helpers/seed.js";

const FAKE_OWNER_TELEGRAM_ID = "100000000001";
const FAKE_MEMBER_TELEGRAM_ID = "100000000002";

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
let termService: TermDepositApplicationService;
let reminderService: TermDepositReminderService;
let reminderRepo: D1ReminderRepository;
let depositRepo: D1TermDepositRepository;
let identityRepo: D1TelegramIdentityRepository;
let adapter: FakeTelegramAdapter;
let seeded: SeededParents;

beforeEach(async () => {
  db = new FakeD1Database();
  depositRepo = new D1TermDepositRepository(db);
  reminderRepo = new D1ReminderRepository(db);
  termService = new TermDepositApplicationService(depositRepo);
  reminderService = new TermDepositReminderService(reminderRepo, depositRepo);
  identityRepo = new D1TelegramIdentityRepository(db);
  adapter = new FakeTelegramAdapter();
  seeded = await seedDepositParents(db);

  // Bind owner + member Telegram identities. The reminder service routes
  // through the holder's identity.
  const ownerMember = await db
    .prepare("SELECT id, role FROM household_members WHERE role = 'OWNER' LIMIT 1")
    .first<{ id: number; role: string }>();
  expect(ownerMember).not.toBeNull();
  if (ownerMember === null) return;
  await db
    .prepare("INSERT INTO telegram_identities (member_id, telegram_user_id) VALUES (?, ?)")
    .bind(ownerMember.id, FAKE_OWNER_TELEGRAM_ID)
    .run();
  await db
    .prepare("INSERT INTO telegram_identities (member_id, telegram_user_id) VALUES (?, ?)")
    .bind(seeded.otherMemberId, FAKE_MEMBER_TELEGRAM_ID)
    .run();
});

afterEach(() => db.close());

async function createActiveDeposit(
  holderMemberId: number,
  accountId: number,
  bankId: number
): Promise<number> {
  const r = await termService.createDraft(
    VALID_DRAFT({
      accountId,
      bankId,
      holderMemberId,
    })
  );
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("seed failed");
  const id = r.value.record.id;
  await termService.submitForReview(id);
  await termService.activate(id);
  return id;
}

function buildDeliveryService(
  fromDate: string,
  toDate: string,
  override?: { adapter?: FakeTelegramAdapter }
): TelegramReminderDeliveryService {
  return new TelegramReminderDeliveryService({
    adapter: override?.adapter ?? adapter,
    reminderRepository: reminderRepo,
    depositRepository: depositRepo,
    identities: identityRepo,
    fromDate,
    toDate,
  });
}

describe("reminder delivery", () => {
  it("sends due pending reminders through the adapter", async () => {
    const depositId = await createActiveDeposit(seeded.memberId, seeded.accountId, seeded.bankId);
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const delivery = buildDeliveryService("2026-01-01", "2026-04-01");
    const outcome = await delivery.deliverDueReminders();
    expect(outcome.attempted).toBeGreaterThan(0);
    expect(outcome.delivered).toBeGreaterThan(0);
    expect(outcome.failed).toBe(0);
    expect(adapter.sentMessages.length).toBe(outcome.delivered);
    const sent = adapter.sentMessages[0]!;
    expect(sent.text.toLowerCase()).toContain("reminder");
    expect(sent.options?.replyMarkup).toBeDefined();

    // After delivery the reminder rows are in DELIVERED status.
    const statusRow = await db
      .prepare("SELECT status FROM term_deposit_reminders WHERE deposit_id = ? LIMIT 1")
      .bind(depositId)
      .first<{ status: string }>();
    expect(statusRow?.status).toBe("DELIVERED");
  });

  it("a failing transport leaves the reminder PENDING (does NOT fabricate success)", async () => {
    const depositId = await createActiveDeposit(seeded.memberId, seeded.accountId, seeded.bankId);
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);

    const failingAdapter = new FakeTelegramAdapter();
    failingAdapter.sendMessage = async () => {
      throw new Error("simulated_transport_failure");
    };
    const delivery = buildDeliveryService("2026-01-01", "2026-04-01", { adapter: failingAdapter });
    const outcome = await delivery.deliverDueReminders();
    expect(outcome.delivered).toBe(0);
    expect(outcome.failed).toBeGreaterThan(0);

    const allRows = await db
      .prepare("SELECT status FROM term_deposit_reminders WHERE deposit_id = ?")
      .bind(depositId)
      .all<{ status: string }>();
    for (const r of allRows.results) {
      expect(r.status).toBe("PENDING");
    }
  });
});

describe("mute does NOT alter deposit business state", () => {
  it("muting a reminder leaves the deposit row untouched", async () => {
    const depositId = await createActiveDeposit(seeded.memberId, seeded.accountId, seeded.bankId);
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const reminderId = scan.value.createdIds[0]!;

    const before = await termService.getDeposit(depositId);
    expect(before.ok).toBe(true);
    if (!before.ok || before.value === null) throw new Error("deposit missing");

    const muteResult = await reminderService.mute(reminderId);
    expect(muteResult.ok).toBe(true);

    const after = await termService.getDeposit(depositId);
    expect(after.ok).toBe(true);
    if (!after.ok || after.value === null) throw new Error("deposit missing");
    expect(after.value.record.state).toBe("ACTIVE");
    expect(after.value.record.principalMinor).toBe(before.value.record.principalMinor);
    expect(after.value.record.updatedAt).toBe(before.value.record.updatedAt);

    // Muted reminders are not delivered.
    const delivery = buildDeliveryService("2026-01-01", "2026-04-01");
    const outcome = await delivery.deliverDueReminders();
    expect(outcome.skippedMuted).toBeGreaterThan(0);
    expect(outcome.delivered).toBe(0);
  });
});

describe("delivery service — allowlist enforcement", () => {
  it("a resolved identity outside the managed allowlist is skipped, transport not called", async () => {
    await createActiveDeposit(seeded.memberId, seeded.accountId, seeded.bankId);
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    // The OWNER is seeded with FAKE_OWNER_TELEGRAM_ID (100000000001).
    // The allowed allowlist deliberately includes ONLY the MEMBER ID, so
    // the OWNER's persisted identity is not in the set. The service
    // must refuse to send and must keep the row PENDING.
    const delivery = new TelegramReminderDeliveryService({
      adapter,
      reminderRepository: reminderRepo,
      depositRepository: depositRepo,
      identities: identityRepo,
      fromDate: "2026-01-01",
      toDate: "2026-04-01",
      allowedUserIds: {
        ids: new Set([FAKE_MEMBER_TELEGRAM_ID]),
        ok: true as const,
      },
    });
    const outcome = await delivery.deliverDueReminders();
    expect(outcome.delivered).toBe(0);
    expect(adapter.sentMessages).toHaveLength(0);

    // Every due reminder is still PENDING — the next tick can retry if
    // the managed allowlist is repaired.
    const stillPending = await db
      .prepare(
        "SELECT COUNT(*) AS c FROM term_deposit_reminders WHERE target_date BETWEEN '2026-01-01' AND '2026-04-01' AND status = 'PENDING'"
      )
      .first<{ c: number }>();
    expect(stillPending?.c).toBeGreaterThan(0);
  });
});
