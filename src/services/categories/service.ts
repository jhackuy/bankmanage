/**
 * Categories application service.
 *
 * Platform-neutral orchestration. Enforces slug hygiene, immutability of
 * `slug`/`is_system`, and the favorites "rise to the front" semantics
 * (SPEC §6.1).
 *
 * Categories are never physically deleted. To remove a category from
 * active use, call `deactivateCategory` (sets active=0). Posted
 * transactions must still resolve their category_id reference (SPEC §7).
 *
 * System categories (is_system=1, seeded by migration 0001) ARE editable:
 * their name, icon, sort_order and active flag can be patched. Only slug
 * and is_system are locked. This matches SPEC §6.1: "OWNER can edit
 * favorites and categories."
 */

import type { CategoryRepository } from "./repository.js";
import {
  fail,
  ok,
  serviceError,
  type CategoryRecord,
  type CategoryWithFavorite,
  type CreateCategoryInput,
  type ServiceResult,
  type UpdateCategoryPatch,
} from "./types.js";

const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export class CategoryApplicationService {
  constructor(private readonly repo: CategoryRepository) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  async getCategory(id: number): Promise<ServiceResult<CategoryRecord | null>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "category id must be a positive safe integer");
    }
    return ok(await this.repo.findById(id));
  }

  async listCategories(includeInactive: boolean): Promise<ServiceResult<CategoryRecord[]>> {
    return ok(await this.repo.listAll(includeInactive));
  }

  /**
   * SPEC §6.1 — list categories for a member ordered by favorites
   * "rising to the front". Categories with a favorite row surface first,
   * ordered by favorite.sort_order ASC, then by category.sort_order ASC
   * for stable presentation.
   */
  async listCategoriesForMember(
    memberId: number,
    includeInactive: boolean
  ): Promise<ServiceResult<CategoryWithFavorite[]>> {
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    return ok(await this.repo.listWithFavorites(memberId, includeInactive));
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async createCategory(input: CreateCategoryInput): Promise<ServiceResult<CategoryRecord>> {
    const validation = validateCreateInput(input);
    if (!validation.ok) return validation;

    const existing = await this.repo.findBySlug(input.slug);
    if (existing !== null) {
      return fail("CATEGORY_SLUG_TAKEN", `category slug '${input.slug}' already exists`);
    }

    if (input.parentId !== undefined && input.parentId !== null) {
      const parent = await this.repo.findById(input.parentId);
      if (parent === null) {
        return fail("CATEGORY_PARENT_INVALID", `parent category ${input.parentId} not found`);
      }
    }

    let record: CategoryRecord;
    try {
      record = await this.repo.insert(input);
    } catch (err) {
      // Race-safe boundary: the UNIQUE constraint on slug catches a
      // concurrent insert with the same slug. The service-level pre-check
      // covers the common case; this branch covers the race.
      if (err instanceof Error && /UNIQUE constraint failed: categories\.slug/i.test(err.message)) {
        return fail("CATEGORY_SLUG_TAKEN", `category slug '${input.slug}' already exists`);
      }
      return fail("INTERNAL", "Unable to create category");
    }
    return ok(record);
  }

  async updateCategory(id: number, patch: UpdateCategoryPatch): Promise<ServiceResult<CategoryRecord>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "category id must be a positive safe integer");
    }
    const existing = await this.repo.findById(id);
    if (existing === null) {
      return fail("CATEGORY_NOT_FOUND", `category ${id} not found`);
    }
    const patchCheck = validatePatch(patch);
    if (!patchCheck.ok) return patchCheck;
    if (patch.parentId !== undefined && patch.parentId !== null && patch.parentId === id) {
      return fail("CATEGORY_PARENT_INVALID", "category cannot be its own parent");
    }
    if (patch.parentId !== undefined && patch.parentId !== null) {
      const parent = await this.repo.findById(patch.parentId);
      if (parent === null) {
        return fail("CATEGORY_PARENT_INVALID", `parent category ${patch.parentId} not found`);
      }
    }

    let updated: CategoryRecord;
    try {
      updated = await this.repo.update(id, patch);
    } catch (err) {
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to update category");
    }
    return ok(updated);
  }

  /**
   * Deactivate (soft-delete) a category. Sets active=0. The row stays in
   * the table so historical ledger entries can resolve their category_id
   * reference (SPEC §7). Re-activation is possible via updateCategory.
   */
  async deactivateCategory(id: number): Promise<ServiceResult<CategoryRecord>> {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return fail("INVALID_INPUT", "category id must be a positive safe integer");
    }
    const existing = await this.repo.findById(id);
    if (existing === null) {
      return fail("CATEGORY_NOT_FOUND", `category ${id} not found`);
    }
    if (existing.active === 0) {
      return ok(existing); // already inactive — no-op
    }
    try {
      const updated = await this.repo.setActive(id, 0);
      return ok(updated);
    } catch (err) {
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to deactivate category");
    }
  }

  /**
   * Bump the per-member favorite use_count for a category and mark it as
   * last-used now. Called by the transaction service after a successful
   * INCOME/EXPENSE post so frequently used categories rise to the front
   * (SPEC §6.1).
   *
   * The application uses a simple model: the favorite's sort_order is
   * left at its initial value (the category's own sort_order). On the
   * first use the favorite row is inserted with use_count=1; subsequent
   * uses UPDATE use_count in place. The list query orders favorites by
   * sort_order ASC, so within the same sort_order, more frequently used
   * categories still tie. A future slice can implement a heuristic that
   * decreases sort_order based on use_count to surface top-N above the
   * rest; M2A only requires the data layer to exist.
   */
  async recordCategoryUse(
    memberId: number,
    categoryId: number
  ): Promise<ServiceResult<{ useCount: number }>> {
    if (!Number.isSafeInteger(memberId) || memberId <= 0) {
      return fail("INVALID_INPUT", "memberId must be a positive safe integer");
    }
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
      return fail("INVALID_INPUT", "categoryId must be a positive safe integer");
    }
    const ctx = await this.repo.loadCategoryContext(categoryId);
    if (ctx === null) {
      return fail("CATEGORY_NOT_FOUND", `category ${categoryId} not found`);
    }
    const existing = await this.repo.findFavorite(memberId, categoryId);
    const nowIso = new Date().toISOString();

    if (existing === null) {
      // First use for this member: insert with sort_order equal to the
      // category's own sort_order so the favorite sits in the right
      // initial position relative to others.
      const category = await this.repo.findById(categoryId);
      if (category === null) {
        return fail("CATEGORY_NOT_FOUND", `category ${categoryId} not found`);
      }
      try {
        const fav = await this.repo.upsertFavorite(memberId, categoryId, {
          sortOrder: category.sortOrder,
          useCount: 1,
          lastUsedAt: nowIso,
        });
        return ok({ useCount: fav.useCount });
      } catch (err) {
        return fail("INTERNAL", err instanceof Error ? err.message : "Unable to record category use");
      }
    }

    // Subsequent use: increment use_count and refresh last_used_at.
    try {
      const fav = await this.repo.upsertFavorite(memberId, categoryId, {
        useCount: existing.useCount + 1,
        lastUsedAt: nowIso,
      });
      return ok({ useCount: fav.useCount });
    } catch (err) {
      return fail("INTERNAL", err instanceof Error ? err.message : "Unable to record category use");
    }
  }
}

// ── Pure validators ─────────────────────────────────────────────────────────

function validateCreateInput(input: CreateCategoryInput): ServiceResult<true> {
  if (typeof input.slug !== "string" || !SLUG_PATTERN.test(input.slug)) {
    return fail("INVALID_INPUT", "slug must match /^[a-z][a-z0-9-]*$/ (lowercase, digits, hyphens)");
  }
  if (typeof input.name !== "string" || input.name.trim() === "") {
    return fail("INVALID_INPUT", "name must be a non-empty string");
  }
  if (input.icon !== undefined && input.icon !== null && typeof input.icon !== "string") {
    return fail("INVALID_INPUT", "icon must be a string or null");
  }
  if (input.sortOrder !== undefined && !Number.isSafeInteger(input.sortOrder)) {
    return fail("INVALID_INPUT", "sortOrder must be a safe integer");
  }
  if (input.parentId !== undefined && input.parentId !== null) {
    if (!Number.isSafeInteger(input.parentId) || input.parentId <= 0) {
      return fail("INVALID_INPUT", "parentId must be a positive safe integer or null");
    }
  }
  return ok(true);
}

function validatePatch(patch: UpdateCategoryPatch): ServiceResult<true> {
  if (patch.name !== undefined && (typeof patch.name !== "string" || patch.name.trim() === "")) {
    return fail("INVALID_INPUT", "name must be a non-empty string");
  }
  if (patch.icon !== undefined && patch.icon !== null && typeof patch.icon !== "string") {
    return fail("INVALID_INPUT", "icon must be a string or null");
  }
  if (patch.sortOrder !== undefined && !Number.isSafeInteger(patch.sortOrder)) {
    return fail("INVALID_INPUT", "sortOrder must be a safe integer");
  }
  if (patch.active !== undefined && patch.active !== 0 && patch.active !== 1) {
    return fail("INVALID_INPUT", "active must be 0 or 1");
  }
  if (patch.parentId !== undefined && patch.parentId !== null) {
    if (!Number.isSafeInteger(patch.parentId) || patch.parentId <= 0) {
      return fail("INVALID_INPUT", "parentId must be a positive safe integer or null");
    }
  }
  return ok(true);
}

// ── Helper: re-export serviceError for callers that want to log codes ───────

export { serviceError };
