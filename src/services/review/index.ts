/**
 * Review application-service barrel.
 *
 * Re-exports the M3C review-flow surface: the repository port, the
 * D1 adapter, the application service, and the platform-neutral types.
 *
 * PHASE 1 scope: RECEIPT flows only. DEPOSIT and SETTLEMENT types are
 * exported for forward compatibility but their confirm entrypoints are
 * not yet implemented on the application service.
 */

export {
  type ReviewSessionRepository,
  type UpdateCorrectedPayloadResult,
  type ConfirmSessionResult,
} from "./repository.js";

export { D1ReviewSessionRepository } from "./d1-repository.js";

export { ReviewApplicationService } from "./service.js";

export {
  type ConfirmDepositInput,
  type ConfirmPatch,
  type ConfirmReceiptInput,
  type ConfirmResult,
  type ConfirmSettlementInput,
  type CorrectFieldsInput,
  type InsertReviewSessionInput,
  type RejectInput,
  type ReviewKind,
  type ReviewSessionRecord,
  type ReviewSessionView,
  type ReviewStatus,
  REVIEW_KINDS,
  type ServiceError,
  type ServiceErrorCode,
  type ServiceResult,
  type SubmitForReviewInput,
  fail,
  ok,
  serviceError,
} from "./types.js";
