/**
 * Accounts application-service barrel.
 *
 * Re-exports the public surface of the M2A accounts slice. The Worker /
 * Hono layer (and any future Mini App API) must import from this barrel
 * rather than reaching into internal files.
 */

export {
  type AccountContext,
  type AccountRepository,
  type BankContext,
  type CurrencyContext,
  type MemberContext,
} from "./repository.js";

export { D1AccountRepository } from "./d1-repository.js";

export { AccountApplicationService, serviceError } from "./service.js";

export {
  type AccountRecord,
  type CreateAccountInput,
  type ServiceError,
  type ServiceErrorCode,
  type ServiceResult,
  type UpdateAccountPatch,
  fail,
  ok,
} from "./types.js";
