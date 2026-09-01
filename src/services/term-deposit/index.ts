/**
 * Term-deposit application-service barrel.
 *
 * Re-exports the public surface of the M1B slice. The Worker/Hono layer
 * must import from this barrel rather than reaching into internal files.
 */

export {
  type AccountContext,
  type BankContext,
  type CurrencyContext,
  type MemberContext,
  type TermDepositRepository,
} from "./repository.js";

export { D1TermDepositRepository } from "./d1-repository.js";

export { TermDepositApplicationService, serviceError } from "./service.js";

export {
  type BankQuotedPatch,
  type CreateDraftInput,
  type EditableFactsPatch,
  type ServiceError,
  type ServiceErrorCode,
  type ServiceResult,
  type TermDepositRecord,
  type TermDepositWithEstimate,
  fail,
  ok,
} from "./types.js";
