/**
 * tests/unit/telegram-scheduled-handler.test.ts
 *
 * Verifies the Cloudflare Workers scheduled (cron) handler that drives the
 * outbound Telegram reminder delivery path:
 *   - Success path: a due reminder is delivered through the production
 *     dependency graph and marked DELIVERED.
 *   - Retry after send failure: a transport failure leaves the reminder
 *     PENDING; the next cron tick retries and succeeds.
 *   - Repeated Cron / idempotency: after a successful delivery, subsequent
 *     cron ticks produce zero duplicate logical delivery.
 *   - Mute behavior: muted reminders are skipped and the deposit row is
 *     untouched.
 *   - Missing managed configuration fail-closed: a missing
 *     `TELEGRAM_BOT_TOKEN` or a malformed `TELEGRAM_ALLOWED_USER_IDS`
 *     causes the handler to return `null` and never invoke the adapter.
 *
 * The tests inject a fake Telegram adapter so no real Bot API call is
 * ever made. The fake's `sendMessage` is overrideable to simulate a
 * transport failure.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import {
  FakeTelegramAdapter,
  FAKE_MEMBER_USER_ID,
  FAKE_OWNER_USER_ID,
} from "../../src/adapters/telegram/fake.js";
import type { TelegramAdapter } from "../../src/adapters/telegram/interface.js";
import {
  D1ReminderRepository,
  D1TermDepositRepository,
  TermDepositApplicationService,
  TermDepositReminderService,
  type CreateDraftInput,
} from "../../src/services/term-deposit/index.js";
import { runTelegramReminderCron, handleScheduled, utcTodayDate } from "../../src/worker/scheduled.js";
import { seedDepositParents, type SeededParents } from "../_helpers/seed.js";
import type { Env } from "../../src/worker/env.js";

const FAKE_BOT_TOKEN = "synthetic_bot_token_NOT_REAL_VALUE_abcdef";

// Fixed UTC date for every test — keeps the window deterministic and
// independent of wall-clock time. A deposit with maturityDate="2099-09-05"
// has D_MINUS_30 = 2089-08-06 (out of window), so we use 2026-09-05 with a
// maturityDate that produces D_MINUS_30 = "2026-09-05".
const TODAY = "2026-09-05";
// Maturity 2026-10-05 -> D_MINUS_30 = 2026-09-05 (matches TODAY).
const MATURITY_FOR_D_MINUS_30 = "2026-10-05";

const VALID_DRAFT = (overrides: Partial<CreateDraftInput> = {}): CreateDraftInput => ({
  accountId: 0,
  bankId: 0,
  holderMemberId: 0,
  currencyCode: "PHP",
  productName: "Test TD Product",
  certificateLastFour: "1234",
  principalMinor: 10_000_000,
  startDate: "2026-04-05",
  maturityDate: MATURITY_FOR_D_MINUS_30,
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
let ownerIdentityId: number;
let ownerMemberId: number;
let ownerBankId: number;
let ownerAccountId: number;
let seeded: SeededParents;

const ADAPTER_FOR =
  (a: FakeTelegramAdapter) =>
  (_token: string): TelegramAdapter =>
    a;

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret",
    TELEGRAM_ALLOWED_USER_IDS: `${FAKE_OWNER_USER_ID},${FAKE_MEMBER_USER_ID}`,
    APP_ENV: "test",
    DB: db as never,
    DOCUMENTS: {} as never,
    ...extra,
  } as unknown as Env;
}

async function createActiveDeposit(): Promise<number> {
  const r = await termService.createDraft(
    VALID_DRAFT({
      accountId: ownerAccountId,
      bankId: ownerBankId,
      holderMemberId: ownerMemberId,
    })
  );
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("seed failed");
  const id = r.value.record.id;
  await termService.submitForReview(id);
  await termService.activate(id);
  return id;
}

beforeEach(async () => {
  db = new FakeD1Database();
  const depositRepo = new D1TermDepositRepository(db);
  const reminderRepo = new D1ReminderRepository(db);
  termService = new TermDepositApplicationService(depositRepo);
  reminderService = new TermDepositReminderService(reminderRepo, depositRepo);
  seeded = await seedDepositParents(db);
  ownerMemberId = seeded.memberId;
  ownerBankId = seeded.bankId;
  ownerAccountId = seeded.accountId;

  const ownerRow = await db
    .prepare("SELECT id FROM household_members WHERE role = 'OWNER' LIMIT 1")
    .first<{ id: number }>();
  if (ownerRow === null) throw new Error("owner seed missing");
  ownerIdentityId = ownerRow.id;
  await db
    .prepare("INSERT INTO telegram_identities (member_id, telegram_user_id) VALUES (?, ?)")
    .bind(ownerIdentityId, FAKE_OWNER_USER_ID)
    .run();
});

afterEach(() => db.close());

describe("cron handler — success path", () => {
  it("delivers a due PENDING reminder through the adapter and marks it DELIVERED", async () => {
    const depositId = await createActiveDeposit();
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    // Sanity: at least one D_MINUS_30 reminder for this deposit has
    // target_date == TODAY (so it falls in the cron window).
    const dueRow = await db
      .prepare("SELECT id, status FROM term_deposit_reminders WHERE deposit_id = ? AND target_date = ?")
      .bind(depositId, TODAY)
      .first<{ id: number; status: string }>();
    expect(dueRow).not.toBeNull();
    expect(dueRow?.status).toBe("PENDING");

    const adapter = new FakeTelegramAdapter();
    const outcome = await runTelegramReminderCron({
      env: makeEnv(),
      ctx: {} as never,
      today: () => TODAY,
      buildAdapter: ADAPTER_FOR(adapter),
    });
    expect(outcome).not.toBeNull();
    if (outcome === null) return;
    expect(outcome.attempted).toBeGreaterThan(0);
    expect(outcome.delivered).toBe(outcome.attempted);
    expect(outcome.failed).toBe(0);
    expect(adapter.sentMessages).toHaveLength(outcome.delivered);
    expect(adapter.sentMessages[0]?.chatId).toBe(FAKE_OWNER_USER_ID);
    expect(adapter.sentMessages[0]?.text.toLowerCase()).toContain("reminder");
    expect(adapter.sentMessages[0]?.options?.replyMarkup).toBeDefined();

    const afterStatus = await db
      .prepare("SELECT status FROM term_deposit_reminders WHERE id = ?")
      .bind(dueRow!.id)
      .first<{ status: string }>();
    expect(afterStatus?.status).toBe("DELIVERED");
  });
});

describe("cron handler — retry after send failure", () => {
  it("a failing transport keeps the row PENDING; the next cron tick retries and succeeds", async () => {
    const depositId = await createActiveDeposit();
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const dueRow = await db
      .prepare("SELECT id, status FROM term_deposit_reminders WHERE deposit_id = ? AND target_date = ?")
      .bind(depositId, TODAY)
      .first<{ id: number; status: string }>();
    expect(dueRow?.status).toBe("PENDING");

    // Tick 1: transport fails. The row MUST stay PENDING.
    const failingAdapter = new FakeTelegramAdapter();
    failingAdapter.sendMessage = async () => {
      throw new Error("simulated_transport_failure");
    };
    const failedOutcome = await runTelegramReminderCron({
      env: makeEnv(),
      ctx: {} as never,
      today: () => TODAY,
      buildAdapter: ADAPTER_FOR(failingAdapter),
    });
    expect(failedOutcome).not.toBeNull();
    if (failedOutcome === null) return;
    expect(failedOutcome.delivered).toBe(0);
    expect(failedOutcome.failed).toBeGreaterThan(0);
    expect(failedOutcome.errors.length).toBeGreaterThan(0);
    expect(failedOutcome.errors[0]).toMatch(/simulated_transport_failure/);

    const afterFail = await db
      .prepare("SELECT status FROM term_deposit_reminders WHERE id = ?")
      .bind(dueRow!.id)
      .first<{ status: string }>();
    expect(afterFail?.status).toBe("PENDING");

    // Tick 2: transport succeeds. The PENDING row is delivered.
    const workingAdapter = new FakeTelegramAdapter();
    const successOutcome = await runTelegramReminderCron({
      env: makeEnv(),
      ctx: {} as never,
      today: () => TODAY,
      buildAdapter: ADAPTER_FOR(workingAdapter),
    });
    expect(successOutcome).not.toBeNull();
    if (successOutcome === null) return;
    expect(successOutcome.delivered).toBe(failedOutcome.failed);
    expect(successOutcome.failed).toBe(0);
    expect(workingAdapter.sentMessages).toHaveLength(successOutcome.delivered);

    const afterSuccess = await db
      .prepare("SELECT status FROM term_deposit_reminders WHERE id = ?")
      .bind(dueRow!.id)
      .first<{ status: string }>();
    expect(afterSuccess?.status).toBe("DELIVERED");
  });
});

describe("cron handler — repeated Cron / idempotency", () => {
  it("a second cron tick after delivery produces zero duplicate logical delivery", async () => {
    const depositId = await createActiveDeposit();
    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    // Tick 1 — first delivery.
    const adapter = new FakeTelegramAdapter();
    const first = await runTelegramReminderCron({
      env: makeEnv(),
      ctx: {} as never,
      today: () => TODAY,
      buildAdapter: ADAPTER_FOR(adapter),
    });
    expect(first).not.toBeNull();
    if (first === null) return;
    const firstDelivered = first.delivered;
    expect(firstDelivered).toBeGreaterThan(0);
    const firstSentCount = adapter.sentMessages.length;
    expect(firstSentCount).toBe(firstDelivered);

    // Tick 2 — already delivered rows must NOT be sent again.
    const second = await runTelegramReminderCron({
      env: makeEnv(),
      ctx: {} as never,
      today: () => TODAY,
      buildAdapter: ADAPTER_FOR(adapter),
    });
    expect(second).not.toBeNull();
    if (second === null) return;
    expect(second.attempted).toBe(0);
    expect(second.delivered).toBe(0);
    expect(second.failed).toBe(0);
    // No duplicate messages to Telegram.
    expect(adapter.sentMessages).toHaveLength(firstSentCount);

    // Reminder rows are still DELIVERED — no oscillation.
    const stillDelivered = await db
      .prepare(
        "SELECT COUNT(*) AS c FROM term_deposit_reminders WHERE deposit_id = ? AND status = 'DELIVERED'"
      )
      .bind(depositId)
      .first<{ c: number }>();
    expect(stillDelivered?.c).toBeGreaterThan(0);
    const noPending = await db
      .prepare(
        "SELECT COUNT(*) AS c FROM term_deposit_reminders WHERE deposit_id = ? AND status = 'PENDING' AND target_date = ?"
      )
      .bind(depositId, TODAY)
      .first<{ c: number }>();
    expect(noPending?.c).toBe(0);
  });
});

describe("cron handler — mute behavior", () => {
  it("muted reminders are skipped and the deposit row is untouched", async () => {
    const depositId = await createActiveDeposit();
    const beforeDeposit = await termService.getDeposit(depositId);
    expect(beforeDeposit.ok).toBe(true);
    if (!beforeDeposit.ok || beforeDeposit.value === null) throw new Error("deposit missing");

    const scan = await reminderService.scanAll();
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const reminderId = scan.value.createdIds[0]!;

    const muteResult = await reminderService.mute(reminderId);
    expect(muteResult.ok).toBe(true);

    const adapter = new FakeTelegramAdapter();
    const outcome = await runTelegramReminderCron({
      env: makeEnv(),
      ctx: {} as never,
      today: () => TODAY,
      buildAdapter: ADAPTER_FOR(adapter),
    });
    expect(outcome).not.toBeNull();
    if (outcome === null) return;
    expect(outcome.skippedMuted).toBeGreaterThan(0);
    expect(outcome.delivered).toBe(0);
    expect(adapter.sentMessages).toHaveLength(0);

    // Deposit business state is unchanged.
    const afterDeposit = await termService.getDeposit(depositId);
    expect(afterDeposit.ok).toBe(true);
    if (!afterDeposit.ok || afterDeposit.value === null) throw new Error("deposit missing");
    expect(afterDeposit.value.record.state).toBe(beforeDeposit.value.record.state);
    expect(afterDeposit.value.record.principalMinor).toBe(beforeDeposit.value.record.principalMinor);
    expect(afterDeposit.value.record.updatedAt).toBe(beforeDeposit.value.record.updatedAt);
  });
});

describe("cron handler — fail-closed on missing managed configuration", () => {
  it("returns null without invoking the adapter when TELEGRAM_BOT_TOKEN is missing", async () => {
    const depositId = await createActiveDeposit();
    await reminderService.scanAll();
    const adapter = new FakeTelegramAdapter();
    const outcome = await runTelegramReminderCron({
      env: makeEnv({ TELEGRAM_BOT_TOKEN: "" }),
      ctx: {} as never,
      today: () => TODAY,
      buildAdapter: ADAPTER_FOR(adapter),
    });
    expect(outcome).toBeNull();
    expect(adapter.sentMessages).toHaveLength(0);
    // Reminder rows are still PENDING — a future tick (after config fix)
    // can retry delivery. SPEC §5 safely-retryable boundary.
    const stillPending = await db
      .prepare("SELECT COUNT(*) AS c FROM term_deposit_reminders WHERE deposit_id = ? AND status = 'PENDING'")
      .bind(depositId)
      .first<{ c: number }>();
    expect(stillPending?.c).toBeGreaterThan(0);
  });

  it("returns null without invoking the adapter when TELEGRAM_ALLOWED_USER_IDS is malformed", async () => {
    const depositId = await createActiveDeposit();
    await reminderService.scanAll();
    const adapter = new FakeTelegramAdapter();
    const outcome = await runTelegramReminderCron({
      env: makeEnv({ TELEGRAM_ALLOWED_USER_IDS: "not-a-valid-binding" }),
      ctx: {} as never,
      today: () => TODAY,
      buildAdapter: ADAPTER_FOR(adapter),
    });
    expect(outcome).toBeNull();
    expect(adapter.sentMessages).toHaveLength(0);
    const stillPending = await db
      .prepare("SELECT COUNT(*) AS c FROM term_deposit_reminders WHERE deposit_id = ? AND status = 'PENDING'")
      .bind(depositId)
      .first<{ c: number }>();
    expect(stillPending?.c).toBeGreaterThan(0);
  });

  it("handleScheduled never throws when managed configuration is missing", async () => {
    const adapter = new FakeTelegramAdapter();
    const env = makeEnv({ TELEGRAM_BOT_TOKEN: "" });
    // Should resolve without throwing — Cloudflare logs capture the
    // structured error from inside the handler.
    await expect(
      handleScheduled({ scheduledTime: 1, cron: "0 * * * *" } as never, env, {
        waitUntil: () => undefined,
      } as never)
    ).resolves.toBeUndefined();
    expect(adapter.sentMessages).toHaveLength(0);
  });
});

describe("utcTodayDate", () => {
  it("returns YYYY-MM-DD in UTC", () => {
    const result = utcTodayDate(new Date(Date.UTC(2026, 8, 5, 23, 59, 59)));
    expect(result).toBe("2026-09-05");
  });

  it("rolls forward across UTC midnight", () => {
    const result = utcTodayDate(new Date(Date.UTC(2026, 0, 1, 0, 0, 1)));
    expect(result).toBe("2026-01-01");
  });
});
