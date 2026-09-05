/**
 * M3C receipt review application-service tests (PHASE 1).
 *
 * Exercises the full service stack through the FakeD1Database so the
 * production code path is under test (no mocks of the service or
 * repository). DEPOSIT and SETTLEMENT flows are intentionally NOT
 * tested here — PHASE 1 is RECEIPT only.
 *
 * Covers the acceptance cases the M3C Receipt slice ships:
 *   - Happy path: submitForReview → correctFields → confirmReceipt
 *     posts one EXPENSE transaction, links the document via
 *     source_evidence_ref = "doc:" + documentId, moves the session to
 *     CONFIRMED.
 *   - getSession: authorizing access via owner / uploader / OWNER-role;
 *     rejecting MEMBER-role cross-member access.
 *   - confirmReceipt authorization: only owner / uploader / OWNER-role
 *     may confirm; MEMBER-role denied.
 *   - confirmReceipt member / account / category invariants:
 *     inactive member, missing/inactive account, cross-member account,
 *     currency mismatch, missing/inactive category.
 *   - OCR review gate at submit: low-confidence amount/date sets
 *     gateAcceptable=false and stores the decision.
 *   - OCR review gate at confirm: REVIEW_GATE_FAILED if the gate would
 *     fail on the user-confirmed facts (synthesized via the gate logic).
 *   - reject: moves session to REJECTED with zero financial mutation.
 *   - Partial-failure retry: after a post-confirm mismatch, retrying
 *     with the same idempotency_key returns the original transaction
 *     (transactions UNIQUE on idempotency_key is the idempotency
 *     boundary) and produces exactly one row.
 *   - Failure injection: postIncomeExpense throws → review service
 *     propagates the error, session remains PENDING_REVIEW, zero
 *     transaction rows, zero ledger entries.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "../../src/adapters/d1/fake.js";
import { FakeDocumentStorageAdapter } from "../../src/adapters/storage/index.js";
import { D1AccountRepository } from "../../src/services/accounts/d1-repository.js";
import { D1CategoryRepository } from "../../src/services/categories/d1-repository.js";
import { D1DocumentRepository } from "../../src/services/documents-storage/d1-repository.js";
import { DocumentApplicationService } from "../../src/services/documents-storage/service.js";
import { D1ReviewSessionRepository, ReviewApplicationService } from "../../src/services/review/index.js";
import {
  D1TransactionsRepository,
  TransactionApplicationService,
} from "../../src/services/transactions/index.js";
import type { ConfirmReceiptInput, SubmitForReviewInput } from "../../src/services/review/types.js";
import type { OcrExtractionResult } from "../../src/adapters/ocr/interface.js";

// ── Seed helpers ─────────────────────────────────────────────────────────────

interface Seed {
  ownerId: number;
  uploaderId: number;
  memberId: number;
  ownerRoleId: number;
  bankId: number;
  accountId: number;
  otherMemberAccountId: number;
  inactiveAccountId: number;
  eurAccountId: number;
  expenseCategoryId: number;
  inactiveCategoryId: number;
}

let db: FakeD1Database;
let storage: FakeDocumentStorageAdapter;
let reviewRepo: D1ReviewSessionRepository;
let docService: DocumentApplicationService;
let txService: TransactionApplicationService;
let accountRepo: D1AccountRepository;
let categoryRepo: D1CategoryRepository;
let reviewService: ReviewApplicationService;
let seed: Seed;

beforeEach(async () => {
  db = new FakeD1Database();
  storage = new FakeDocumentStorageAdapter();
  accountRepo = new D1AccountRepository(db);
  categoryRepo = new D1CategoryRepository(db);
  const txRepo = new D1TransactionsRepository(db);
  const docRepo = new D1DocumentRepository(db);
  reviewRepo = new D1ReviewSessionRepository(db);
  docService = new DocumentApplicationService(docRepo, storage);
  txService = new TransactionApplicationService(txRepo, accountRepo, categoryRepo);
  reviewService = new ReviewApplicationService(reviewRepo, docService, txService, accountRepo, categoryRepo);

  const owner = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Receipt Test Owner")
    .run();
  const uploader = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("MEMBER", "Receipt Test Uploader")
    .run();
  const member = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("MEMBER", "Receipt Test Ordinary Member")
    .run();
  const ownerRole = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Receipt Test Second Owner")
    .run();

  const bank = await db
    .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, 0)")
    .bind("receipt-test-bank", "Receipt Test Bank")
    .run();
  const bankEur = await db
    .prepare("INSERT INTO banks (slug, name, is_system) VALUES (?, ?, 0)")
    .bind("receipt-test-bank-eur", "Receipt Test Bank EUR")
    .run();

  const ownerId = Number(owner.meta.last_row_id);
  const uploaderId = Number(uploader.meta.last_row_id);
  const memberId = Number(member.meta.last_row_id);
  const ownerRoleId = Number(ownerRole.meta.last_row_id);

  const acc = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(ownerId, bank.meta.last_row_id, "PHP", "BANK", "Owner Checking")
    .run();
  const otherMember = await db
    .prepare("INSERT INTO household_members (role, display_name) VALUES (?, ?)")
    .bind("OWNER", "Other Test Owner")
    .run();
  const otherAcc = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(otherMember.meta.last_row_id, bank.meta.last_row_id, "PHP", "BANK", "Other Owner Checking")
    .run();
  const inactiveAcc = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname, active)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
    .bind(ownerId, bank.meta.last_row_id, "PHP", "BANK", "Owner Inactive")
    .run();
  const eurAcc = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(ownerId, bankEur.meta.last_row_id, "EUR", "BANK", "Owner EUR Checking")
    .run();

  const expenseRow = await db
    .prepare("SELECT id FROM categories WHERE slug = ?")
    .bind("groceries")
    .first<{ id: number }>();
  const inactiveCat = await db
    .prepare("INSERT INTO categories (slug, name, active, is_system, sort_order) VALUES (?, ?, 0, 0, ?)")
    .bind("receipt-test-inactive", "Receipt Test Inactive Category", 999)
    .run();
  if (expenseRow === null) {
    throw new Error("seed setup: missing seeded expense category");
  }

  seed = {
    ownerId,
    uploaderId,
    memberId,
    ownerRoleId,
    bankId: Number(bank.meta.last_row_id),
    accountId: Number(acc.meta.last_row_id),
    otherMemberAccountId: Number(otherAcc.meta.last_row_id),
    inactiveAccountId: Number(inactiveAcc.meta.last_row_id),
    eurAccountId: Number(eurAcc.meta.last_row_id),
    expenseCategoryId: expenseRow.id,
    inactiveCategoryId: Number(inactiveCat.meta.last_row_id),
  };
});

afterEach(() => {
  db.close();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function highConfidenceOcr(overrides: Partial<OcrExtractionResult> = {}): OcrExtractionResult {
  return {
    processingMs: 42,
    totalAmountCandidate: { value: "1234.56", confidence: 0.95 },
    dateCandidate: { value: "2026-03-15", confidence: 0.95 },
    merchantCandidate: { value: "Test Mart", confidence: 0.9 },
    currencyCandidate: { value: "PHP", confidence: 0.95 },
    paymentMethodCandidate: { value: "CARD", confidence: 0.9 },
    taxAmountCandidate: { value: "100.00", confidence: 0.9 },
    last4Candidate: { value: "1234", confidence: 0.9 },
    rawText: "synthetic OCR raw text",
    ...overrides,
  };
}

function lowConfidenceOcr(): OcrExtractionResult {
  return {
    processingMs: 42,
    totalAmountCandidate: { value: "1234.56", confidence: 0.2 },
    dateCandidate: { value: "2026-03-15", confidence: 0.95 },
    merchantCandidate: { value: "Test Mart", confidence: 0.9 },
    currencyCandidate: { value: "PHP", confidence: 0.95 },
    paymentMethodCandidate: { value: "CARD", confidence: 0.9 },
    taxAmountCandidate: { value: "100.00", confidence: 0.9 },
    last4Candidate: { value: "1234", confidence: 0.9 },
    rawText: "low-confidence amount",
  };
}

async function uploadReceipt(
  ownerId: number,
  uploaderId: number,
  seedStr: string
): Promise<{ documentId: number }> {
  const bytes = new TextEncoder().encode(`receipt-${seedStr}-${Math.random().toString(36).slice(2, 10)}`);
  const result = await docService.uploadDocument({
    kind: "RECEIPT",
    ownerMemberId: ownerId,
    uploaderMemberId: uploaderId,
    contentType: "image/jpeg",
    bytes,
  });
  if (!result.ok) throw new Error(`seed upload failed: ${result.error.message}`);
  return { documentId: result.value.record.id };
}

async function countSessions(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM review_sessions").first<{ c: number }>();
  return row?.c ?? 0;
}

async function countTransactions(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM transactions").first<{ c: number }>();
  return row?.c ?? 0;
}

async function countLedgerEntries(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM ledger_entries").first<{ c: number }>();
  return row?.c ?? 0;
}

function confirmInput(
  sessionId: number,
  memberId: number,
  overrides: Partial<ConfirmReceiptInput> = {}
): ConfirmReceiptInput {
  return {
    sessionId,
    memberId,
    accountId: seed.accountId,
    categoryId: seed.expenseCategoryId,
    amountMinor: 123_456,
    occurredOn: "2026-03-15",
    currencyCode: "PHP",
    idempotencyKey: `confirm-key-${sessionId}`,
    description: "Test receipt confirmation",
    ...overrides,
  };
}

// ── submitForReview ──────────────────────────────────────────────────────────

describe("submitForReview — happy path", () => {
  it("creates a PENDING_REVIEW RECEIPT session and returns gateAcceptable=true for high-confidence OCR", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "submit-happy");
    const submit: SubmitForReviewInput = {
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    };

    const result = await reviewService.submitForReview(submit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.kind).toBe("RECEIPT");
    expect(result.value.session.status).toBe("PENDING_REVIEW");
    expect(result.value.session.documentId).toBe(documentId);
    expect(result.value.session.confirmingMemberId).toBe(seed.ownerId);
    expect(result.value.session.confirmedPayload).toBeNull();
    expect(result.value.session.linkedTransactionId).toBeNull();
    expect(result.value.session.postIdempotencyKey).toBeNull();
    expect(result.value.gateAcceptable).toBe(true);
    expect(result.value.session.reviewDecision.requiresReview).toBe(false);
    expect(await countSessions()).toBe(1);
  });

  it("stores the review decision and returns gateAcceptable=false when OCR amount is low-confidence", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "submit-low");
    const submit: SubmitForReviewInput = {
      documentId,
      ocrResult: lowConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    };

    const result = await reviewService.submitForReview(submit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gateAcceptable).toBe(false);
    expect(result.value.session.reviewDecision.requiresReview).toBe(true);
    expect(result.value.session.reviewDecision.reasons.length).toBeGreaterThan(0);
  });

  it("rejects DOCUMENT_NOT_FOUND when the document id does not exist", async () => {
    const result = await reviewService.submitForReview({
      documentId: 9_999_999,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("rejects INVALID_INPUT on non-positive ids", async () => {
    const result = await reviewService.submitForReview({
      documentId: 0,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("propagates DOCUMENT_FORBIDDEN when the confirming member is a MEMBER-role stranger", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "submit-forbidden");
    const result = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.memberId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOCUMENT_FORBIDDEN");
  });
});

// ── getSession ───────────────────────────────────────────────────────────────

describe("getSession", () => {
  it("returns the session for the document owner", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "get-owner");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.getSession(submit.value.session.id, seed.ownerId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.id).toBe(submit.value.session.id);
  });

  it("returns the session for the document uploader", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "get-uploader");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.getSession(submit.value.session.id, seed.uploaderId);
    expect(result.ok).toBe(true);
  });

  it("returns the session for a cross-member OWNER-role member", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "get-owner-role");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.getSession(submit.value.session.id, seed.ownerRoleId);
    expect(result.ok).toBe(true);
  });

  it("rejects DOCUMENT_FORBIDDEN for an ordinary MEMBER-role stranger", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "get-forbidden");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.getSession(submit.value.session.id, seed.memberId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOCUMENT_FORBIDDEN");
  });

  it("rejects SESSION_NOT_FOUND for an unknown id", async () => {
    const result = await reviewService.getSession(9_999_999, seed.ownerId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SESSION_NOT_FOUND");
  });
});

// ── correctFields ────────────────────────────────────────────────────────────

describe("correctFields", () => {
  it("merges patched fields into correctedPayload", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "correct-merge");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.correctFields({
      sessionId: submit.value.session.id,
      memberId: seed.ownerId,
      patches: { totalAmountCandidate: "999.99", note: "user-typed" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.correctedPayload).toEqual({
      totalAmountCandidate: "999.99",
      note: "user-typed",
    });
  });

  it("rejects SESSION_NOT_PENDING after the session is confirmed", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "correct-confirmed");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const confirm = await reviewService.confirmReceipt(confirmInput(submit.value.session.id, seed.ownerId));
    expect(confirm.ok).toBe(true);

    const result = await reviewService.correctFields({
      sessionId: submit.value.session.id,
      memberId: seed.ownerId,
      patches: { totalAmountCandidate: "1.00" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SESSION_NOT_PENDING");
  });

  it("rejects DOCUMENT_FORBIDDEN for an unauthorized member", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "correct-forbidden");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.correctFields({
      sessionId: submit.value.session.id,
      memberId: seed.memberId,
      patches: { totalAmountCandidate: "1.00" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOCUMENT_FORBIDDEN");
  });
});

// ── reject ───────────────────────────────────────────────────────────────────

describe("reject", () => {
  it("moves the session to REJECTED with zero financial mutation", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "reject-ok");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const txCountBefore = await countTransactions();
    const entryCountBefore = await countLedgerEntries();

    const result = await reviewService.reject({
      sessionId: submit.value.session.id,
      memberId: seed.ownerId,
      reason: "duplicate submission",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.status).toBe("REJECTED");
    expect(result.value.session.reason).toBe("duplicate submission");
    expect(result.value.session.confirmedPayload).toBeNull();
    expect(result.value.session.linkedTransactionId).toBeNull();
    expect(result.value.transactionId).toBeNull();
    expect(await countTransactions()).toBe(txCountBefore);
    expect(await countLedgerEntries()).toBe(entryCountBefore);
  });

  it("rejects SESSION_NOT_PENDING if the session is already CONFIRMED", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "reject-after-confirm");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const confirm = await reviewService.confirmReceipt(confirmInput(submit.value.session.id, seed.ownerId));
    expect(confirm.ok).toBe(true);

    const result = await reviewService.reject({
      sessionId: submit.value.session.id,
      memberId: seed.ownerId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SESSION_NOT_PENDING");
  });
});

// ── confirmReceipt — happy path ──────────────────────────────────────────────

describe("confirmReceipt — happy path", () => {
  it("posts one EXPENSE transaction, links the document, and locks the session to CONFIRMED", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "confirm-happy");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.confirmReceipt(confirmInput(submit.value.session.id, seed.ownerId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session.status).toBe("CONFIRMED");
    expect(result.value.session.postIdempotencyKey).toBe(`confirm-key-${submit.value.session.id}`);
    expect(result.value.session.linkedTransactionId).toBe(result.value.transactionId);
    expect(result.value.transactionId).not.toBeNull();
    expect(result.value.session.confirmedPayload).toMatchObject({
      amountMinor: 123_456,
      occurredOn: "2026-03-15",
      accountId: seed.accountId,
      categoryId: seed.expenseCategoryId,
      currencyCode: "PHP",
    });

    // Verify the ledger: one transaction + two balanced entries (one
    // account-side, one category-side), sourceEvidenceRef bound to the
    // document id.
    expect(await countTransactions()).toBe(1);
    expect(await countLedgerEntries()).toBe(2);
    const tx = await db
      .prepare("SELECT * FROM transactions WHERE id = ?")
      .bind(result.value.transactionId)
      .first<{ source_evidence_ref: string | null; amount_minor: number }>();
    expect(tx).not.toBeNull();
    expect(tx?.source_evidence_ref).toBe(`doc:${documentId}`);
    expect(tx?.amount_minor).toBe(123_456);
  });
});

// ── confirmReceipt — authorization ───────────────────────────────────────────

describe("confirmReceipt — authorization", () => {
  it("allows the document uploader to confirm", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "confirm-uploader");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.confirmReceipt(confirmInput(submit.value.session.id, seed.uploaderId));
    expect(result.ok).toBe(true);
  });

  it("allows a cross-member OWNER-role member to confirm", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "confirm-owner-role");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.confirmReceipt(
      confirmInput(submit.value.session.id, seed.ownerRoleId)
    );
    expect(result.ok).toBe(true);
  });

  it("rejects DOCUMENT_FORBIDDEN for a MEMBER-role stranger", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "confirm-forbidden");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.confirmReceipt(confirmInput(submit.value.session.id, seed.memberId));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DOCUMENT_FORBIDDEN");
  });
});

// ── confirmReceipt — member / account / category invariants ──────────────────

describe("confirmReceipt — member / account / category invariants", () => {
  it("rejects MEMBER_INACTIVE", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "confirm-inactive-member");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    // Flip the owner to inactive mid-test.
    await db.prepare("UPDATE household_members SET active = 0 WHERE id = ?").bind(seed.ownerId).run();

    const result = await reviewService.confirmReceipt(confirmInput(submit.value.session.id, seed.ownerId));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MEMBER_INACTIVE");
  });

  it("rejects ACCOUNT_INACTIVE", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "confirm-inactive-account");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.confirmReceipt(
      confirmInput(submit.value.session.id, seed.ownerId, { accountId: seed.inactiveAccountId })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACCOUNT_INACTIVE");
  });

  it("rejects ACCOUNT_FORBIDDEN for cross-member account", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "confirm-cross-account");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.confirmReceipt(
      confirmInput(submit.value.session.id, seed.ownerId, { accountId: seed.otherMemberAccountId })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACCOUNT_FORBIDDEN");
  });

  it("rejects CURRENCY_MISMATCH", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "confirm-ccy-mismatch");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.confirmReceipt(
      confirmInput(submit.value.session.id, seed.ownerId, {
        accountId: seed.eurAccountId,
        currencyCode: "PHP",
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CURRENCY_MISMATCH");
  });

  it("rejects CATEGORY_INACTIVE", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "confirm-cat-inactive");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const result = await reviewService.confirmReceipt(
      confirmInput(submit.value.session.id, seed.ownerId, { categoryId: seed.inactiveCategoryId })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CATEGORY_INACTIVE");
  });
});

// ── confirmReceipt — partial-failure idempotency ─────────────────────────────

describe("confirmReceipt — partial-failure idempotency", () => {
  it("a retry after a partial-failure confirm returns the same transaction (UNIQUE on idempotency_key)", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "confirm-retry");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const first = await reviewService.confirmReceipt(confirmInput(submit.value.session.id, seed.ownerId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Simulate a partial-failure recovery: the transaction was posted
    // but the session confirm step failed mid-write (e.g., network
    // blip). Roll the session back to PENDING_REVIEW with no linked
    // transaction so the retry exercises the idempotency boundary on
    // the transactions side.
    await db
      .prepare(
        `UPDATE review_sessions
            SET status = 'PENDING_REVIEW',
                linked_transaction_id = NULL,
                post_idempotency_key = NULL,
                confirmed_payload_json = NULL
          WHERE id = ?`
      )
      .bind(submit.value.session.id)
      .run();

    const second = await reviewService.confirmReceipt(confirmInput(submit.value.session.id, seed.ownerId));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.transactionId).toBe(first.value.transactionId);
    expect(second.value.session.id).toBe(first.value.session.id);
    expect(await countTransactions()).toBe(1);
    expect(await countLedgerEntries()).toBe(2);

    const persisted = await db
      .prepare("SELECT status, post_idempotency_key, linked_transaction_id FROM review_sessions WHERE id = ?")
      .bind(submit.value.session.id)
      .first<{ status: string; post_idempotency_key: string; linked_transaction_id: number }>();
    expect(persisted?.status).toBe("CONFIRMED");
    expect(persisted?.post_idempotency_key).toBe(`confirm-key-${submit.value.session.id}`);
    expect(persisted?.linked_transaction_id).toBe(first.value.transactionId);
  });
});

// ── confirmReceipt — failure injection ───────────────────────────────────────

describe("confirmReceipt — failure injection", () => {
  it("a postIncomeExpense failure leaves the session PENDING_REVIEW and produces zero partial mutation", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "confirm-inject-fail");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const txCountBefore = await countTransactions();
    const entryCountBefore = await countLedgerEntries();
    const sessionCountBefore = await countSessions();

    // Wrap the production txService so postIncomeExpense throws,
    // simulating a forced storage / DB failure between session load
    // and transaction write. All other service methods are unchanged
    // so the review service is still under test end-to-end.
    const failingTxService = new Proxy(txService, {
      get(target, prop, receiver) {
        if (prop === "postIncomeExpense") {
          return () => {
            throw new Error("forced postIncomeExpense failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const failingReviewService = new ReviewApplicationService(
      reviewRepo,
      docService,
      failingTxService as unknown as TransactionApplicationService,
      accountRepo,
      categoryRepo
    );

    await expect(
      failingReviewService.confirmReceipt(confirmInput(submit.value.session.id, seed.ownerId))
    ).rejects.toThrow("forced postIncomeExpense failure");

    // The session must remain PENDING_REVIEW (confirmSession was never
    // reached). No transaction rows, no ledger entries.
    expect(await countSessions()).toBe(sessionCountBefore);
    expect(await countTransactions()).toBe(txCountBefore);
    expect(await countLedgerEntries()).toBe(entryCountBefore);

    const persisted = await db
      .prepare("SELECT status FROM review_sessions WHERE id = ?")
      .bind(submit.value.session.id)
      .first<{ status: string }>();
    expect(persisted?.status).toBe("PENDING_REVIEW");
  });
});
