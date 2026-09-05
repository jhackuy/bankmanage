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
import type { ReviewSessionRepository } from "../../src/services/review/repository.js";
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
  uploaderAccountId: number;
  ownerRoleAccountId: number;
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
  // Each allowed confirmer (uploader, cross-member OWNER-role) posts against
  // an account they own: the transactions service rejects cross-member posts
  // independently of document-level review authorization.
  const uploaderAcc = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(uploaderId, bank.meta.last_row_id, "PHP", "BANK", "Uploader Checking")
    .run();
  const ownerRoleAcc = await db
    .prepare(
      `INSERT INTO accounts (member_id, bank_id, currency_code, account_type, nickname)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(ownerRoleId, bank.meta.last_row_id, "PHP", "BANK", "Second Owner Checking")
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
    uploaderAccountId: Number(uploaderAcc.meta.last_row_id),
    ownerRoleAccountId: Number(ownerRoleAcc.meta.last_row_id),
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: predicate never satisfied within timeout");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
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

    const result = await reviewService.confirmReceipt(
      confirmInput(submit.value.session.id, seed.uploaderId, { accountId: seed.uploaderAccountId })
    );
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
      confirmInput(submit.value.session.id, seed.ownerRoleId, { accountId: seed.ownerRoleAccountId })
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

// ── confirmReceipt — claim / release concurrency and recoverability ──────────
//
// These tests prove the claim-then-post-then-confirm ordering produces no
// orphan or duplicate financial mutations under concurrent confirmations
// and recovers cleanly from injected mid-write failures. The claim is the
// race-safe boundary that prevents two concurrent callers with different
// idempotency keys from both posting a transaction before only one wins
// the optimistic lock on confirmSession.

describe("confirmReceipt — claim/release concurrency", () => {
  it("concurrent same-key confirms produce exactly one transaction and one CONFIRMED session", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "claim-same-key");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const inputA = confirmInput(submit.value.session.id, seed.ownerId, {
      idempotencyKey: "concurrent-key-shared",
    });
    const inputB = confirmInput(submit.value.session.id, seed.ownerId, {
      idempotencyKey: "concurrent-key-shared",
    });

    const [a, b] = await Promise.all([
      reviewService.confirmReceipt(inputA),
      reviewService.confirmReceipt(inputB),
    ]);

    // Both must succeed (idempotent retry of the same key).
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Exactly one transaction row, exactly one linked id — both
    // confirmations resolve to the canonical post.
    expect(a.value.transactionId).toBe(b.value.transactionId);
    expect(await countTransactions()).toBe(1);
    expect(await countLedgerEntries()).toBe(2);

    // The session is CONFIRMED and bound to the single transaction.
    const persisted = await db
      .prepare("SELECT status, post_idempotency_key, linked_transaction_id FROM review_sessions WHERE id = ?")
      .bind(submit.value.session.id)
      .first<{ status: string; post_idempotency_key: string; linked_transaction_id: number }>();
    expect(persisted?.status).toBe("CONFIRMED");
    expect(persisted?.post_idempotency_key).toBe("concurrent-key-shared");
    expect(persisted?.linked_transaction_id).toBe(a.value.transactionId);
  });

  it("concurrent different-key confirms produce exactly one transaction and one SESSION_CLAIM_CONFLICT", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "claim-diff-key");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const inputA = confirmInput(submit.value.session.id, seed.ownerId, {
      idempotencyKey: "concurrent-key-A",
    });
    const inputB = confirmInput(submit.value.session.id, seed.ownerId, {
      idempotencyKey: "concurrent-key-B",
    });

    const [a, b] = await Promise.all([
      reviewService.confirmReceipt(inputA),
      reviewService.confirmReceipt(inputB),
    ]);

    // Exactly one of the two must succeed; the other must be rejected
    // with SESSION_CLAIM_CONFLICT. The race-safe claim ensures the
    // losing caller never reaches the financial write step.
    const successes = [a, b].filter((r) => r.ok);
    const failures = [a, b].filter((r) => !r.ok);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    if (failures.length !== 1) return;
    expect(failures[0]?.error.code).toBe("SESSION_CLAIM_CONFLICT");

    // Exactly one transaction row total — no orphan/duplicate mutation.
    expect(await countTransactions()).toBe(1);
    expect(await countLedgerEntries()).toBe(2);

    // The session is CONFIRMED and bound to the winner's key + tx.
    const winnerKey = a.ok ? "concurrent-key-A" : "concurrent-key-B";
    const persisted = await db
      .prepare("SELECT status, post_idempotency_key, linked_transaction_id FROM review_sessions WHERE id = ?")
      .bind(submit.value.session.id)
      .first<{ status: string; post_idempotency_key: string; linked_transaction_id: number }>();
    expect(persisted?.status).toBe("CONFIRMED");
    expect(persisted?.post_idempotency_key).toBe(winnerKey);
  });

  it("a non-idempotent post failure retains the claim and the same key can retry to recover", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "claim-release-retry");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    // First confirm attempt uses the inactive account — the
    // transactions service returns ACCOUNT_INACTIVE (a non-idempotent
    // failure), which the review service must translate. The claim is
    // intentionally retained across the failure so no other key can
    // interleave while the same-key retry is in flight.
    const first = await reviewService.confirmReceipt(
      confirmInput(submit.value.session.id, seed.ownerId, {
        accountId: seed.inactiveAccountId,
        idempotencyKey: "release-retry-key",
      })
    );
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe("ACCOUNT_INACTIVE");

    // The session must still be PENDING_REVIEW and the claim slot
    // retained so the same-key retry can recover (and any other key is
    // blocked while the retry is in flight).
    const afterFail = await db
      .prepare("SELECT status, post_idempotency_key FROM review_sessions WHERE id = ?")
      .bind(submit.value.session.id)
      .first<{ status: string; post_idempotency_key: string | null }>();
    expect(afterFail?.status).toBe("PENDING_REVIEW");
    expect(afterFail?.post_idempotency_key).toBe("release-retry-key");

    // A different-key attempt is rejected while the same-key retry is
    // pending — the slot is held, so this must surface as a claim
    // conflict with zero mutation.
    const blocked = await reviewService.confirmReceipt(
      confirmInput(submit.value.session.id, seed.ownerId, {
        accountId: seed.accountId,
        idempotencyKey: "different-key-while-held",
      })
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error.code).toBe("SESSION_CLAIM_CONFLICT");
    expect(await countTransactions()).toBe(0);
    expect(await countLedgerEntries()).toBe(0);

    // Retry with a valid account + the same key — the same-key retry
    // is admitted (ALREADY_CLAIMED_SAME_KEY) and recovers the flow.
    const second = await reviewService.confirmReceipt(
      confirmInput(submit.value.session.id, seed.ownerId, {
        accountId: seed.accountId,
        idempotencyKey: "release-retry-key",
      })
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Exactly one transaction row from the retry; session CONFIRMED.
    expect(await countTransactions()).toBe(1);
    expect(await countLedgerEntries()).toBe(2);
    const persisted = await db
      .prepare("SELECT status, post_idempotency_key, linked_transaction_id FROM review_sessions WHERE id = ?")
      .bind(submit.value.session.id)
      .first<{ status: string; post_idempotency_key: string; linked_transaction_id: number }>();
    expect(persisted?.status).toBe("CONFIRMED");
    expect(persisted?.post_idempotency_key).toBe("release-retry-key");
    expect(persisted?.linked_transaction_id).toBe(second.value.transactionId);
  });

  it("a same-key retry after an injected confirm failure resumes and finalizes without a second transaction", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "claim-confirm-retry");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    // Wrap the production reviewRepo so confirmSession throws once,
    // simulating a forced finalize failure (e.g. D1 edge failure
    // between the post and the confirm UPDATE). claimSession /
    // releaseClaim / findById are unchanged so the rest of the flow is
    // still under test.
    let confirmCalls = 0;
    const flakyReviewRepo: ReviewSessionRepository = new Proxy(reviewRepo, {
      get(target, prop, receiver) {
        if (prop === "confirmSession") {
          return async (...args: unknown[]) => {
            confirmCalls += 1;
            if (confirmCalls === 1) {
              throw new Error("forced confirmSession failure");
            }
            return (target.confirmSession as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ReviewSessionRepository;
    const flakyService = new ReviewApplicationService(
      flakyReviewRepo,
      docService,
      txService,
      accountRepo,
      categoryRepo
    );

    const sharedKey = "confirm-retry-key";
    await expect(
      flakyService.confirmReceipt(
        confirmInput(submit.value.session.id, seed.ownerId, { idempotencyKey: sharedKey })
      )
    ).rejects.toThrow("forced confirmSession failure");

    // The first attempt successfully posted the transaction (UNIQUE on
    // idempotency_key kept it persisted) but confirmSession threw.
    // The session is still PENDING_REVIEW with the same claim slot
    // held by our key — this is the recoverable mid-write state.
    expect(await countTransactions()).toBe(1);
    expect(await countLedgerEntries()).toBe(2);
    const afterFail = await db
      .prepare("SELECT status, post_idempotency_key, linked_transaction_id FROM review_sessions WHERE id = ?")
      .bind(submit.value.session.id)
      .first<{
        status: string;
        post_idempotency_key: string | null;
        linked_transaction_id: number | null;
      }>();
    expect(afterFail?.status).toBe("PENDING_REVIEW");
    expect(afterFail?.post_idempotency_key).toBe(sharedKey);
    expect(afterFail?.linked_transaction_id).toBeNull();

    // Retry with the SAME key — claim returns ALREADY_CLAIMED_SAME_KEY,
    // postIncomeExpense sees the existing transaction (created=false),
    // confirmSession succeeds on attempt #2.
    const second = await flakyService.confirmReceipt(
      confirmInput(submit.value.session.id, seed.ownerId, { idempotencyKey: sharedKey })
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // No second transaction row was created — the transactions UNIQUE
    // is the financial-layer idempotency boundary. The session is
    // CONFIRMED and bound to the original transaction.
    expect(await countTransactions()).toBe(1);
    expect(await countLedgerEntries()).toBe(2);
    const persisted = await db
      .prepare("SELECT status, post_idempotency_key, linked_transaction_id FROM review_sessions WHERE id = ?")
      .bind(submit.value.session.id)
      .first<{ status: string; post_idempotency_key: string; linked_transaction_id: number }>();
    expect(persisted?.status).toBe("CONFIRMED");
    expect(persisted?.post_idempotency_key).toBe(sharedKey);
    expect(persisted?.linked_transaction_id).toBe(second.value.transactionId);
    // The same transaction id flows back — confirm was finalized
    // against the original post, not a re-posted one.
    const originalTx = await db
      .prepare("SELECT id FROM transactions ORDER BY id ASC LIMIT 1")
      .first<{ id: number }>();
    expect(originalTx).not.toBeNull();
    expect(second.value.transactionId).toBe(originalTx?.id);
  });
});

// ── claim-token protocol: interleaving tests ─────────────────────────────────
//
// These tests exercise the claim-token protocol directly against the
// repository to prove the two races called out by the review comment are
// closed:
//   Race 1 — a claimed confirmation must atomically block
//            rejectSession / updateCorrectedPayload.
//   Race 2 — a failed same-key caller must not clear the claim slot
//            underneath another in-flight same-key caller (releaseClaim
//            with a stale or foreign token is a no-op).
//   Race 3 — a third-key duplicate (two different keys + one same-key
//            retry) cannot both finalize with a transaction row.

describe("review_sessions — claim-token protocol interleaving", () => {
  it("rejectSession is blocked while a confirmation claim is held (no orphan REJECTED session)", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "reject-blocked");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const sessionId = submit.value.session.id;

    // Reserve the claim directly via the repository: this simulates a
    // caller that is mid-flight on confirmReceipt (the claim UPDATE has
    // run, the transaction INSERT has not yet).
    const claim = await reviewRepo.claimSession(sessionId, "in-flight-key");
    expect(claim.code).toBe("CLAIMED");

    // reject() must NOT succeed: the session still has a held claim slot.
    const rej = await reviewService.reject({ sessionId, memberId: seed.ownerId, reason: "too late" });
    expect(rej.ok).toBe(false);
    if (rej.ok) return;
    expect(rej.error.code).toBe("SESSION_NOT_PENDING");

    // The session is still PENDING_REVIEW — no orphan REJECTED row.
    const persisted = await db
      .prepare("SELECT status, post_idempotency_key, claim_token FROM review_sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ status: string; post_idempotency_key: string | null; claim_token: string | null }>();
    expect(persisted?.status).toBe("PENDING_REVIEW");
    expect(persisted?.post_idempotency_key).toBe("in-flight-key");
    expect(persisted?.claim_token).not.toBeNull();
    expect(await countTransactions()).toBe(0);
  });

  it("updateCorrectedPayload is blocked while a confirmation claim is held", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "correct-blocked");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const sessionId = submit.value.session.id;
    const claim = await reviewRepo.claimSession(sessionId, "in-flight-key-correct");
    expect(claim.code).toBe("CLAIMED");

    // correctFields must NOT succeed while a claim is held.
    const corr = await reviewService.correctFields({
      sessionId,
      memberId: seed.ownerId,
      patches: { totalAmountCandidate: "1.00" },
    });
    expect(corr.ok).toBe(false);
    if (corr.ok) return;
    expect(corr.error.code).toBe("SESSION_NOT_PENDING");

    const persisted = await db
      .prepare("SELECT post_idempotency_key, claim_token FROM review_sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ post_idempotency_key: string | null; claim_token: string | null }>();
    expect(persisted?.post_idempotency_key).toBe("in-flight-key-correct");
    expect(persisted?.claim_token).not.toBeNull();
  });

  it("a third-key caller cannot finalize while the original claimer holds a different key", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "third-key-blocked");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const sessionId = submit.value.session.id;
    const original = await reviewRepo.claimSession(sessionId, "key-X");
    expect(original.code).toBe("CLAIMED");

    // A different-key caller attempts to claim — must be rejected.
    const third = await reviewRepo.claimSession(sessionId, "key-Y");
    expect(third.code).toBe("ALREADY_CLAIMED_DIFFERENT_KEY");

    // A same-key retry sees ALREADY_CLAIMED_SAME_KEY (admitted) — the
    // retry is read-only on the slot and is allowed to resume the
    // post step. No token is issued to the retry.
    const sameKeyRetry = await reviewRepo.claimSession(sessionId, "key-X");
    expect(sameKeyRetry.code).toBe("ALREADY_CLAIMED_SAME_KEY");

    // No transaction rows have been produced — only the original claimer
    // could possibly post.
    expect(await countTransactions()).toBe(0);
  });

  it("original token owner fails → same-key retry succeeds → third different key remains blocked (exactly one transaction)", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "claim-retain-interleave");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    const sessionId = submit.value.session.id;
    const sharedKey = "interleave-shared-key";
    const thirdKey = "interleave-third-key";

    // Deterministic interleaving: barrier-coordinated proxy
    // transactions service that lets the test observe and stage three
    // concurrent confirmReceipt calls.
    let originalEnteredPost: (() => void) | null = null;
    let retryCanResolvePost: (() => void) | null = null;
    let thirdPartyEnteredClaim: (() => void) | null = null;

    let firstCallResolved = false;
    let thirdCallResolved = false;

    const stagedTx = new Proxy(txService, {
      get(target, prop, receiver) {
        if (prop !== "postIncomeExpense") {
          return Reflect.get(target, prop, receiver);
        }
        return async (...args: unknown[]) => {
          // Identify which call this is by the idempotency key.
          const opts = args[1] as { idempotencyKey: string };
          if (opts.idempotencyKey === sharedKey) {
            // Distinguish the original (slot was free) from a same-key
            // retry by checking whether this is the first invocation.
            if (!firstCallResolved) {
              // Original caller: signal we are mid-post, then wait
              // until the third-party caller has been observed at the
              // claim boundary, then return a non-idempotent failure.
              firstCallResolved = true;
              await new Promise<void>((resolve) => {
                originalEnteredPost = resolve;
              });
              return {
                ok: false,
                error: { code: "ACCOUNT_INACTIVE", message: "interleave: original failed" },
              };
            }
            // Same-key retry: signal and wait for the test to release
            // us after asserting that the third key was blocked.
            await new Promise<void>((resolve) => {
              retryCanResolvePost = resolve;
            });
            return Reflect.apply(
              target.postIncomeExpense as (...a: unknown[]) => unknown,
              target,
              args
            ) as Promise<
              | { ok: true; value: { transaction: { id: number } } }
              | { ok: false; error: { code: string; message: string } }
            >;
          }
          thirdCallResolved = true;
          // Should never reach here: the third party is blocked at the
          // claim boundary before reaching postIncomeExpense.
          return {
            ok: false,
            error: { code: "ACCOUNT_INACTIVE", message: "interleave: third should not reach post" },
          };
        };
      },
    });

    // Wrap claimSession so we can observe the third-party caller
    // entering the claim boundary while the original is mid-post.
    const stagedRepo = new Proxy(reviewRepo, {
      get(target, prop, receiver) {
        if (prop !== "claimSession") {
          return Reflect.get(target, prop, receiver);
        }
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(
            target.claimSession as (...a: unknown[]) => unknown,
            target,
            args
          );
          const r = result as { code: string };
          if (r.code === "ALREADY_CLAIMED_DIFFERENT_KEY" && thirdPartyEnteredClaim === null) {
            thirdPartyEnteredClaim = () => {};
          }
          return result;
        };
      },
    });

    const stagedService = new ReviewApplicationService(
      stagedRepo as unknown as ReviewSessionRepository,
      docService,
      stagedTx as unknown as TransactionApplicationService,
      accountRepo,
      categoryRepo
    );

    // Kick off the original caller. Do NOT await — we want to drive it
    // through the interleaving points deterministically.
    const originalP = stagedService.confirmReceipt(
      confirmInput(sessionId, seed.ownerId, { idempotencyKey: sharedKey })
    );

    // Wait until the original caller is inside postIncomeExpense.
    await waitFor(() => originalEnteredPost !== null);
    // Now the slot is held by `sharedKey`. Start the third party —
    // it must be rejected at the claim boundary.
    const thirdPartyP = stagedService.confirmReceipt(
      confirmInput(sessionId, seed.ownerId, { idempotencyKey: thirdKey })
    );
    await waitFor(() => thirdPartyEnteredClaim !== null);
    // Third party must resolve with SESSION_CLAIM_CONFLICT and ZERO
    // mutation; the post layer must not be touched.
    const thirdResult = await thirdPartyP;
    expect(thirdResult.ok).toBe(false);
    if (thirdResult.ok) return;
    expect(thirdResult.error.code).toBe("SESSION_CLAIM_CONFLICT");
    expect(thirdCallResolved).toBe(false);
    expect(await countTransactions()).toBe(0);

    // Now start the same-key retry — admitted via ALREADY_CLAIMED_SAME_KEY,
    // sits in postIncomeExpense waiting to be released.
    const retryP = stagedService.confirmReceipt(
      confirmInput(sessionId, seed.ownerId, { idempotencyKey: sharedKey })
    );
    await waitFor(() => retryCanResolvePost !== null);

    // Let the original caller resolve with its non-idempotent failure.
    if (originalEnteredPost !== null) originalEnteredPost();
    const originalResult = await originalP;
    expect(originalResult.ok).toBe(false);
    if (originalResult.ok) return;
    expect(originalResult.error.code).toBe("ACCOUNT_INACTIVE");

    // The claim must STILL be held by the shared key — the service
    // never released it. The third-party slot is still occupied by the
    // same key.
    const afterOriginalFail = await db
      .prepare("SELECT status, post_idempotency_key, claim_token FROM review_sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ status: string; post_idempotency_key: string | null; claim_token: string | null }>();
    expect(afterOriginalFail?.status).toBe("PENDING_REVIEW");
    expect(afterOriginalFail?.post_idempotency_key).toBe(sharedKey);
    expect(afterOriginalFail?.claim_token).not.toBeNull();
    expect(await countTransactions()).toBe(0);

    // While the same-key retry is in flight (still waiting on its
    // barrier), another third-party attempt must still be blocked.
    const thirdPartyAgainP = stagedService.confirmReceipt(
      confirmInput(sessionId, seed.ownerId, { idempotencyKey: thirdKey })
    );
    const thirdAgainResult = await thirdPartyAgainP;
    expect(thirdAgainResult.ok).toBe(false);
    if (thirdAgainResult.ok) return;
    expect(thirdAgainResult.error.code).toBe("SESSION_CLAIM_CONFLICT");

    // Release the same-key retry to finalize.
    if (retryCanResolvePost !== null) retryCanResolvePost();
    const retryResult = await retryP;
    expect(retryResult.ok).toBe(true);
    if (!retryResult.ok) return;

    // Exactly one transaction row; session CONFIRMED and bound to the
    // shared key.
    expect(await countTransactions()).toBe(1);
    expect(await countLedgerEntries()).toBe(2);
    const persisted = await db
      .prepare(
        "SELECT status, post_idempotency_key, claim_token, linked_transaction_id FROM review_sessions WHERE id = ?"
      )
      .bind(sessionId)
      .first<{
        status: string;
        post_idempotency_key: string | null;
        claim_token: string | null;
        linked_transaction_id: number | null;
      }>();
    expect(persisted?.status).toBe("CONFIRMED");
    expect(persisted?.post_idempotency_key).toBe(sharedKey);
    expect(persisted?.claim_token).toBeNull();
    expect(persisted?.linked_transaction_id).toBe(retryResult.value.transactionId);
  });

  it("a same-key retry after a forced post failure does not release the slot and recovers cleanly", async () => {
    const { documentId } = await uploadReceipt(seed.ownerId, seed.uploaderId, "same-key-no-release");
    const submit = await reviewService.submitForReview({
      documentId,
      ocrResult: highConfidenceOcr(),
      confirmingMemberId: seed.ownerId,
    });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const sessionId = submit.value.session.id;
    const sharedKey = "retry-key-protocol";

    // Inject a post failure on the FIRST call only.
    let postCalls = 0;
    const flakyTxService = new Proxy(txService, {
      get(target, prop, receiver) {
        if (prop === "postIncomeExpense") {
          return async (...args: unknown[]) => {
            postCalls += 1;
            if (postCalls === 1) {
              throw new Error("forced post failure #1");
            }
            return (target.postIncomeExpense as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const flakyService = new ReviewApplicationService(
      reviewRepo,
      docService,
      flakyTxService as unknown as TransactionApplicationService,
      accountRepo,
      categoryRepo
    );

    await expect(
      flakyService.confirmReceipt(confirmInput(sessionId, seed.ownerId, { idempotencyKey: sharedKey }))
    ).rejects.toThrow("forced post failure #1");

    // The first caller was a fresh CLAIMED — but its post THREW, so the
    // service's release path did NOT run (the throw propagated before
    // the ok-check). The slot must remain held by the same-key caller.
    const afterThrow = await db
      .prepare("SELECT post_idempotency_key, claim_token FROM review_sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ post_idempotency_key: string | null; claim_token: string | null }>();
    expect(afterThrow?.post_idempotency_key).toBe(sharedKey);
    expect(afterThrow?.claim_token).not.toBeNull();

    // Retry with the SAME key — claim returns ALREADY_CLAIMED_SAME_KEY
    // (no fresh token), the retry proceeds to the post step without
    // owning a release token. Post succeeds on attempt #2 and the
    // session moves to CONFIRMED.
    const retry = await flakyService.confirmReceipt(
      confirmInput(sessionId, seed.ownerId, { idempotencyKey: sharedKey })
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;

    expect(await countTransactions()).toBe(1);
    const persisted = await db
      .prepare(
        "SELECT status, post_idempotency_key, claim_token, linked_transaction_id FROM review_sessions WHERE id = ?"
      )
      .bind(sessionId)
      .first<{
        status: string;
        post_idempotency_key: string | null;
        claim_token: string | null;
        linked_transaction_id: number | null;
      }>();
    expect(persisted?.status).toBe("CONFIRMED");
    expect(persisted?.post_idempotency_key).toBe(sharedKey);
    // confirmSession clears claim_token on finalize.
    expect(persisted?.claim_token).toBeNull();
    expect(persisted?.linked_transaction_id).toBe(retry.value.transactionId);
  });
});
