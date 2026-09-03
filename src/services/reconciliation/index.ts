/**
 * Reconciliation application-service barrel.
 *
 * Re-exports the public surface of the M2B reconciliation slice. The
 * Worker / Hono layer (and any future Mini App API or report consumer)
 * must import from this barrel rather than reaching into internal
 * files.
 */

export {
  type EnsureReconciliationInput,
  type EnsureReconciliationResult,
  type ReconciliationRepository,
} from "./repository.js";

export { D1ReconciliationRepository } from "./d1-repository.js";

export {
  ReconciliationApplicationService,
  serviceError,
  type RecordReconciliationResult,
} from "./service.js";

export {
  type PostReconciliationInput,
  type ReconciliationRecord,
  type ServiceError,
  type ServiceErrorCode,
  type ServiceResult,
  type UnreconciledAccount,
  fail,
  ok,
} from "./types.js";
