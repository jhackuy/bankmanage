/**
 * D1 implementation of the categories repository.
 *
 * All SQL is parameterized. No raw D1 binding escapes this module — the
 * application service sees only the abstract `CategoryRepository` port.
 */

import type { D1Database } from "../../adapters/d1/types.js";
import type { CategoryRepository } from "./repository.js";
import type {
  CategoryFavoriteRecord,
  CategoryRecord,
  CategoryWithFavorite,
  CreateCategoryInput,
  UpdateCategoryPatch,
} from "./types.js";

// ── Row types as stored in SQLite ───────────────────────────────────────────

interface CategoryRow {
  id: number;
  parent_id: number | null;
  slug: string;
  name: string;
  icon: string | null;
  sort_order: number;
  is_system: number;
  active: number;
  created_at: string;
  updated_at: string;
}

interface CategoryWithFavoriteRow extends CategoryRow {
  fav_member_id: number | null;
  fav_category_id: number | null;
  fav_sort_order: number | null;
  fav_use_count: number | null;
  fav_last_used_at: string | null;
}

interface CategoryFavoriteRow {
  member_id: number;
  category_id: number;
  sort_order: number;
  use_count: number;
  last_used_at: string | null;
}

function rowToRecord(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    slug: row.slug,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sort_order,
    isSystem: row.is_system,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFavorite(row: CategoryFavoriteRow): CategoryFavoriteRecord {
  return {
    memberId: row.member_id,
    categoryId: row.category_id,
    sortOrder: row.sort_order,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
  };
}

// ── D1 Repository ───────────────────────────────────────────────────────────

export class D1CategoryRepository implements CategoryRepository {
  constructor(private readonly db: D1Database) {}

  async insert(input: CreateCategoryInput): Promise<CategoryRecord> {
    const stmt = this.db
      .prepare(
        `INSERT INTO categories (slug, name, icon, sort_order, parent_id)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`
      )
      .bind(input.slug, input.name, input.icon ?? null, input.sortOrder ?? 0, input.parentId ?? null);
    const row = await stmt.first<CategoryRow>();
    if (row === null) {
      throw new Error("insert: RETURNING produced no row");
    }
    return rowToRecord(row);
  }

  async findById(id: number): Promise<CategoryRecord | null> {
    const row = await this.db.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first<CategoryRow>();
    return row === null ? null : rowToRecord(row);
  }

  async findBySlug(slug: string): Promise<CategoryRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM categories WHERE slug = ?")
      .bind(slug)
      .first<CategoryRow>();
    return row === null ? null : rowToRecord(row);
  }

  async listAll(includeInactive: boolean): Promise<CategoryRecord[]> {
    const sql = includeInactive
      ? "SELECT * FROM categories ORDER BY sort_order ASC, id ASC"
      : "SELECT * FROM categories WHERE active = 1 ORDER BY sort_order ASC, id ASC";
    const result = await this.db.prepare(sql).all<CategoryRow>();
    return result.results.map(rowToRecord);
  }

  async update(id: number, patch: UpdateCategoryPatch): Promise<CategoryRecord> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.icon !== undefined) {
      sets.push("icon = ?");
      params.push(patch.icon);
    }
    if (patch.sortOrder !== undefined) {
      sets.push("sort_order = ?");
      params.push(patch.sortOrder);
    }
    if (patch.active !== undefined) {
      sets.push("active = ?");
      params.push(patch.active);
    }
    if (patch.parentId !== undefined) {
      sets.push("parent_id = ?");
      params.push(patch.parentId);
    }

    if (sets.length === 0) {
      const current = await this.findById(id);
      if (current === null) throw new Error(`update: category ${id} not found`);
      return current;
    }

    sets.push("updated_at = datetime('now', 'utc')");
    const sql = `UPDATE categories SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
    params.push(id);
    const row = await this.db
      .prepare(sql)
      .bind(...(params as never[]))
      .first<CategoryRow>();
    if (row === null) {
      throw new Error(`update: category ${id} not found`);
    }
    return rowToRecord(row);
  }

  async setActive(id: number, active: number): Promise<CategoryRecord> {
    const row = await this.db
      .prepare(
        `UPDATE categories
         SET active = ?, updated_at = datetime('now', 'utc')
         WHERE id = ?
         RETURNING *`
      )
      .bind(active, id)
      .first<CategoryRow>();
    if (row === null) {
      throw new Error(`setActive: category ${id} not found`);
    }
    return rowToRecord(row);
  }

  async listWithFavorites(memberId: number, includeInactive: boolean): Promise<CategoryWithFavorite[]> {
    // LEFT JOIN on (member_id, category_id) so categories without a
    // favorite row are still returned (favorite = null). Order: favorite
    // sort_order first, then category sort_order, then name for stability.
    const sql = includeInactive
      ? `SELECT c.*,
                f.member_id      AS fav_member_id,
                f.category_id    AS fav_category_id,
                f.sort_order     AS fav_sort_order,
                f.use_count      AS fav_use_count,
                f.last_used_at   AS fav_last_used_at
           FROM categories c
           LEFT JOIN account_category_favorites f
             ON f.category_id = c.id AND f.member_id = ?
           ORDER BY (CASE WHEN f.sort_order IS NULL THEN 1 ELSE 0 END) ASC,
                    f.sort_order ASC,
                    c.sort_order ASC,
                    c.name ASC,
                    c.id ASC`
      : `SELECT c.*,
                f.member_id      AS fav_member_id,
                f.category_id    AS fav_category_id,
                f.sort_order     AS fav_sort_order,
                f.use_count      AS fav_use_count,
                f.last_used_at   AS fav_last_used_at
           FROM categories c
           LEFT JOIN account_category_favorites f
             ON f.category_id = c.id AND f.member_id = ?
           WHERE c.active = 1
           ORDER BY (CASE WHEN f.sort_order IS NULL THEN 1 ELSE 0 END) ASC,
                    f.sort_order ASC,
                    c.sort_order ASC,
                    c.name ASC,
                    c.id ASC`;
    const result = await this.db.prepare(sql).bind(memberId).all<CategoryWithFavoriteRow>();
    return result.results.map((row) => {
      const favorite: CategoryFavoriteRecord | null =
        row.fav_member_id === null
          ? null
          : {
              memberId: row.fav_member_id,
              categoryId: row.fav_category_id as number,
              sortOrder: row.fav_sort_order as number,
              useCount: row.fav_use_count as number,
              lastUsedAt: row.fav_last_used_at,
            };
      return {
        category: rowToRecord(row),
        favorite,
      };
    });
  }

  async findFavorite(memberId: number, categoryId: number): Promise<CategoryFavoriteRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT member_id, category_id, sort_order, use_count, last_used_at
           FROM account_category_favorites
           WHERE member_id = ? AND category_id = ?`
      )
      .bind(memberId, categoryId)
      .first<CategoryFavoriteRow>();
    return row === null ? null : rowToFavorite(row);
  }

  async upsertFavorite(
    memberId: number,
    categoryId: number,
    patch: { sortOrder?: number; useCount?: number; lastUsedAt?: string | null }
  ): Promise<CategoryFavoriteRecord> {
    // SQLite UPSERT (ON CONFLICT) keeps the race-safe single-row-per-pair
    // invariant without a pre-read.
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.sortOrder !== undefined) {
      sets.push("sort_order = excluded.sort_order");
      params.push(patch.sortOrder);
    }
    if (patch.useCount !== undefined) {
      sets.push("use_count = excluded.use_count");
      params.push(patch.useCount);
    }
    if (patch.lastUsedAt !== undefined) {
      sets.push("last_used_at = excluded.last_used_at");
      params.push(patch.lastUsedAt);
    }
    sets.push("updated_at = datetime('now', 'utc')");

    const sql =
      `INSERT INTO account_category_favorites (member_id, category_id, sort_order, use_count, last_used_at) ` +
      `VALUES (?, ?, ?, ?, ?) ` +
      `ON CONFLICT(member_id, category_id) DO UPDATE SET ${sets.join(", ")} ` +
      `RETURNING *`;
    // Default values for the columns not in `patch`: sortOrder defaults
    // come from the category's own sort_order at INSERT time (the
    // application service passes sortOrder explicitly), use_count=0,
    // last_used_at=NULL. We mirror those defaults in the INSERT clause.
    const insertSortOrder = patch.sortOrder ?? 0;
    const insertUseCount = patch.useCount ?? 0;
    const insertLastUsedAt = patch.lastUsedAt ?? null;
    const finalParams: unknown[] = [
      memberId,
      categoryId,
      insertSortOrder,
      insertUseCount,
      insertLastUsedAt,
      ...params,
    ];
    const row = await this.db
      .prepare(sql)
      .bind(...(finalParams as never[]))
      .first<CategoryFavoriteRow>();
    if (row === null) {
      throw new Error("upsertFavorite: RETURNING produced no row");
    }
    return rowToFavorite(row);
  }

  async loadCategoryContext(id: number): Promise<{ id: number; active: number; isSystem: number } | null> {
    const row = await this.db
      .prepare("SELECT id, active, is_system FROM categories WHERE id = ?")
      .bind(id)
      .first<{ id: number; active: number; is_system: number }>();
    if (row === null) return null;
    return { id: row.id, active: row.active, isSystem: row.is_system };
  }

  async recordCategoryUse(memberId: number, categoryId: number): Promise<void> {
    // SPEC §6.1 "favorites rise to the front". On first use, insert with
    // use_count=1 and sort_order taken from the category. On subsequent
    // uses, increment use_count and refresh last_used_at. We use a single
    // UPSERT so concurrent calls cannot produce duplicate rows.
    const nowIso = new Date().toISOString();
    const sql = `
      INSERT INTO account_category_favorites (member_id, category_id, sort_order, use_count, last_used_at)
      SELECT ?, c.id, c.sort_order, 1, ?
        FROM categories c
       WHERE c.id = ?
      ON CONFLICT(member_id, category_id) DO UPDATE SET
        use_count = account_category_favorites.use_count + 1,
        last_used_at = excluded.last_used_at,
        updated_at = datetime('now', 'utc')
    `;
    await this.db.prepare(sql).bind(memberId, nowIso, categoryId).run();
  }
}
