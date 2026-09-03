/**
 * Categories application-service barrel.
 *
 * Re-exports the public surface of the M2A categories slice.
 */

export { type CategoryRepository } from "./repository.js";

export { D1CategoryRepository } from "./d1-repository.js";

export { CategoryApplicationService, serviceError } from "./service.js";

export {
  type CategoryFavoriteRecord,
  type CategoryRecord,
  type CategoryWithFavorite,
  type CreateCategoryInput,
  type ServiceError,
  type ServiceErrorCode,
  type ServiceResult,
  type UpdateCategoryPatch,
  fail,
  ok,
} from "./types.js";
