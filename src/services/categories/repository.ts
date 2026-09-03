/**
 * Categories repository interface.
 *
 * Application service depends on this abstract port. The D1 adapter in
 * `./d1-repository.ts` provides the production implementation; tests use
 * the same port against the FakeD1Database binding.
 *
 * The repository is responsible for:
 *   - row-to-domain mapping;
 *   - parameterized SQL only;
 *   - existence checks (category by id / slug, favorite by member+category).
 *
 * The repository does NOT:
 *   - enforce business rules (those live in the application service);
 *   - hard-delete categories (use active=0 instead);
 *   - increment favorite use_count without an explicit method call.
 */

import type {
  CategoryFavoriteRecord,
  CategoryRecord,
  CategoryWithFavorite,
  CreateCategoryInput,
  UpdateCategoryPatch,
} from "./types.js";

export interface CategoryRepository {
  /** Insert a new (non-system) category. Slug must be unique. */
  insert(input: CreateCategoryInput): Promise<CategoryRecord>;

  /** SELECT by id. Returns null if no row matches. */
  findById(id: number): Promise<CategoryRecord | null>;

  /** SELECT by slug. Returns null if no row matches. */
  findBySlug(slug: string): Promise<CategoryRecord | null>;

  /**
   * SELECT every category. When `includeInactive` is false, only
   * categories with active = 1 are returned. Ordered by sort_order ASC,
   * then id ASC.
   */
  listAll(includeInactive: boolean): Promise<CategoryRecord[]>;

  /** Patch mutable fields. Throws if no row matches. */
  update(id: number, patch: UpdateCategoryPatch): Promise<CategoryRecord>;

  /** Set active flag. Soft "delete" — the row stays for ledger resolution. */
  setActive(id: number, active: number): Promise<CategoryRecord>;

  /**
   * Fetch all categories for a member joined with their favorite metadata,
   * ordered by (favorite.sort_order ASC NULLS LAST, categories.sort_order
   * ASC, categories.name ASC). Categories without a favorite row are
   * included with `favorite: null` so the caller can render them in
   * stable, well-defined order.
   */
  listWithFavorites(memberId: number, includeInactive: boolean): Promise<CategoryWithFavorite[]>;

  /**
   * Fetch the favorite metadata for (memberId, categoryId), or null if no
   * row exists. The application service uses this to decide whether to
   * INSERT or UPDATE.
   */
  findFavorite(memberId: number, categoryId: number): Promise<CategoryFavoriteRecord | null>;

  /**
   * INSERT a new favorite row, or UPDATE use_count/sort_order if the
   * (memberId, categoryId) pair already exists. The composite primary
   * key (member_id, category_id) guarantees at most one row per pair.
   */
  upsertFavorite(
    memberId: number,
    categoryId: number,
    patch: { sortOrder?: number; useCount?: number; lastUsedAt?: string | null }
  ): Promise<CategoryFavoriteRecord>;

  /**
   * Record a category use for SPEC §6.1 "favorites rise to the front".
   * If no favorite row exists, inserts one with use_count=1 and
   * sort_order taken from the category. If a row exists, increments
   * use_count and refreshes last_used_at. The caller is expected to
   * have validated that the memberId and categoryId are valid.
   */
  recordCategoryUse(memberId: number, categoryId: number): Promise<void>;

  /** Cheap existence check used by the transaction service. */
  loadCategoryContext(id: number): Promise<{ id: number; active: number; isSystem: number } | null>;
}
