/**
 * Categories application-service types.
 *
 * Categories and per-member favorites. The categories table from migration
 * 0001 is the authoritative existence; the account_category_favorites table
 * from migration 0006 stores per-member sort/use metadata for the
 * "frequently used categories rise to the front" SPEC §6.1 behaviour.
 *
 * Categories are never physically deleted — to remove a category from
 * active use, set active = 0. Posted transactions must still resolve their
 * category_id reference (SPEC §7).
 */

export interface CategoryRecord {
  readonly id: number;
  readonly parentId: number | null;
  readonly slug: string;
  readonly name: string;
  readonly icon: string | null;
  readonly sortOrder: number;
  readonly isSystem: number;
  readonly active: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Per-member favorite category record. `useCount` is bumped every time the
 * category is referenced by a posted transaction. The application service
 * derives the effective display order from these fields.
 */
export interface CategoryFavoriteRecord {
  readonly memberId: number;
  readonly categoryId: number;
  readonly sortOrder: number;
  readonly useCount: number;
  readonly lastUsedAt: string | null;
}

/** Lightweight view of a category with its favorite metadata for one member. */
export interface CategoryWithFavorite {
  readonly category: CategoryRecord;
  readonly favorite: CategoryFavoriteRecord | null;
}

/** Fields required to create a new user category. */
export interface CreateCategoryInput {
  readonly slug: string;
  readonly name: string;
  readonly icon?: string | null;
  readonly sortOrder?: number;
  readonly parentId?: number | null;
}

/**
 * Patchable category fields. slug and is_system are NOT patchable: changing
 * the slug breaks referential integrity, and system categories stay system
 * categories. To "delete" a category, set active = 0.
 */
export interface UpdateCategoryPatch {
  readonly name?: string;
  readonly icon?: string | null;
  readonly sortOrder?: number;
  readonly active?: number;
  readonly parentId?: number | null;
}

// ── Result types ─────────────────────────────────────────────────────────────

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ServiceError };

export interface ServiceError {
  readonly code: ServiceErrorCode;
  readonly message: string;
}

export type ServiceErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_SLUG_TAKEN"
  | "CATEGORY_PARENT_INVALID"
  | "CATEGORY_INACTIVE"
  | "MEMBER_NOT_FOUND"
  | "INTERNAL";

export function serviceError(code: ServiceErrorCode, message: string): ServiceError {
  return { code, message };
}

export function ok<T>(value: T): ServiceResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ServiceErrorCode, message: string): ServiceResult<T> {
  return { ok: false, error: { code, message } };
}
