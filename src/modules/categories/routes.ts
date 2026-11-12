import { Router } from 'express';
import { z } from 'zod';
import pool from '../../db/pool';
import { asyncWrapper, HttpError, publicUploadPath, uploadCategoryImage } from '../../utils';
import { authMiddleware, requirePermission } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { created, ok, paginated } from '../../shared/response';
import { getOffset, PaginationQuery } from '../../shared/pagination';
import { slugify, uniqueSlug } from '../../shared/slug';
import { writeAudit } from '../../services/audit';
import { effectiveProductPrice } from '../../shared/money';
import { assertParentCanHaveSubcategory } from '../../services/categories';

export const router = Router();

function formBool() {
  return z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0', ''])])
    .optional()
    .transform((v) => {
      if (v === '' || v == null) return undefined;
      if (v === true || v === 'true' || v === '1') return true;
      if (v === false || v === 'false' || v === '0') return false;
      return undefined;
    });
}

function formInt(opts?: { min?: number; positive?: boolean }) {
  return z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v, ctx) => {
      if (v === '' || v === null || v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be an integer' });
        return z.NEVER;
      }
      if (opts?.positive && n <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be positive' });
        return z.NEVER;
      }
      if (opts?.min != null && n < opts.min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Must be >= ${opts.min}` });
        return z.NEVER;
      }
      return n;
    });
}

/** multipart form — image is a file field, not a URL */
const CategoryFormBody = z.object({
  name: z.string().min(1, 'اسم التصنيف مطلوب'),
  slug: z
    .string()
    .optional()
    .transform((v) => (v === '' || v == null ? undefined : v)),
  description: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v === '' || v == null ? undefined : v)),
  parent_id: formInt({ positive: true }),
  seo_title: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v === '' || v == null ? undefined : v)),
  seo_description: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v === '' || v == null ? undefined : v)),
  display_order: formInt({ min: 0 }),
  is_featured: formBool(),
  is_active: formBool(),
});

function handleCategoryImage(req: any, res: any, next: any) {
  uploadCategoryImage(req, res, (err: any) => {
    if (err) return next(new HttpError(400, err.message || 'Image upload failed'));
    next();
  });
}

function parseCategoryImage(req: { file?: Express.Multer.File }): string | undefined {
  if (!req.file) return undefined;
  return publicUploadPath('categories', req.file.filename);
}

async function wouldCreateCycle(id: number, parentId: number | null): Promise<boolean> {
  if (!parentId) return false;
  if (parentId === id) return true;
  let current: number | null = parentId;
  const seen = new Set<number>();
  while (current) {
    if (current === id) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    const res: { rows: Array<{ parent_id: number | null }> } = await pool.query<{
      parent_id: number | null;
    }>('SELECT parent_id FROM categories WHERE id = $1', [current]);
    current = res.rows[0]?.parent_id ?? null;
  }
  return false;
}

router.get(
  '/',
  asyncWrapper(async (req, res) => {
    const query = PaginationQuery.extend({
      parent_id: z.coerce.number().optional(),
      is_active: z.enum(['true', 'false']).optional(),
      tree: z.enum(['true', 'false']).optional(),
    }).parse(req.query);

    if (query.tree === 'true') {
      const all = await pool.query('SELECT * FROM categories ORDER BY display_order, name');
      const byParent = new Map<number | null, any[]>();
      for (const row of all.rows) {
        const key = row.parent_id ?? null;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key)!.push({ ...row, children: [] });
      }
      const attach = (nodes: any[]): any[] =>
        nodes.map((n) => {
          const children = attach(byParent.get(n.id) ?? []);
          return {
            ...n,
            children,
            children_count: children.length,
            is_leaf: children.length === 0,
            accepts_products: children.length === 0,
          };
        });
      return ok(res, attach(byParent.get(null) ?? []));
    }

    const values: unknown[] = [];
    const where: string[] = [];
    let i = 1;
    if (query.parent_id !== undefined) {
      where.push(`parent_id = $${i++}`);
      values.push(query.parent_id);
    }
    if (query.is_active) {
      where.push(`is_active = $${i++}`);
      values.push(query.is_active === 'true');
    }
    if (query.q) {
      where.push(`(name ILIKE $${i} OR slug ILIKE $${i})`);
      values.push(`%${query.q}%`);
      i++;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM categories ${whereSql}`,
      values,
    );
    values.push(query.limit, getOffset(query.page, query.limit));
    const result = await pool.query(
      `SELECT * FROM categories ${whereSql}
       ORDER BY display_order ASC, name ASC
       LIMIT $${i++} OFFSET $${i}`,
      values,
    );
    paginated(res, result.rows, {
      total: count.rows[0].total,
      page: query.page,
      limit: query.limit,
    });
  }),
);

/**
 * Homepage: root categories with subcategories + product previews
 * GET /categories/home?limit=10
 *
 * Rule: if a category has subcategories, products live on the subcategory only.
 * Parent cards expose children; leaf categories expose products directly.
 */
router.get(
  '/home',
  asyncWrapper(async (req, res) => {
    const { limit } = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).default(10),
      })
      .parse(req.query);

    const categoriesRes = await pool.query(
      `SELECT c.id, c.name, c.slug, c.description, c.image, c.parent_id, c.is_featured, c.display_order,
              (
                SELECT COUNT(*)::int
                FROM categories ch
                WHERE ch.parent_id = c.id AND ch.is_active = TRUE
              ) AS children_count,
              (
                SELECT COUNT(*)::int
                FROM products p
                WHERE p.category_id = c.id
                  AND p.status = 'active'
                  AND p.is_active = TRUE
              ) AS direct_products_count
       FROM categories c
       WHERE c.is_active = TRUE
       ORDER BY c.display_order ASC, c.name ASC`,
    );

    const productsRes = await pool.query(
      `SELECT *
       FROM (
         SELECT
           p.id,
           p.name,
           p.slug,
           p.price,
           p.sale_price,
           p.sale_starts_at,
           p.sale_ends_at,
           COALESCE(
             NULLIF(p.image, ''),
             (
               SELECT pi.url
               FROM product_images pi
               WHERE pi.product_id = p.id
               ORDER BY pi.position ASC, pi.id ASC
               LIMIT 1
             )
           ) AS image,
           p.stock,
           p.reserved_stock,
           p.category_id,
           p.is_featured,
           p.created_at,
           b.name AS brand_name,
           ROW_NUMBER() OVER (
             PARTITION BY p.category_id
             ORDER BY p.is_featured DESC, p.created_at DESC
           ) AS rn
         FROM products p
         LEFT JOIN brands b ON b.id = p.brand_id
         WHERE p.status = 'active'
           AND p.is_active = TRUE
           AND p.category_id IS NOT NULL
       ) ranked
       WHERE rn <= $1
       ORDER BY category_id, rn`,
      [limit],
    );

    const byCategory = new Map<number, any[]>();
    for (const row of productsRes.rows) {
      const list = byCategory.get(row.category_id) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        slug: row.slug,
        price: row.price,
        discount: row.sale_price,
        effective_price: effectiveProductPrice(row),
        image: row.image,
        brand_name: row.brand_name,
        available_stock: Math.max(0, Number(row.stock) - Number(row.reserved_stock || 0)),
        is_featured: row.is_featured,
      });
      byCategory.set(row.category_id, list);
    }

    const mapCategory = (cat: any) => {
      const childrenCount = Number(cat.children_count) || 0;
      const isLeaf = childrenCount === 0;
      const products = isLeaf ? (byCategory.get(cat.id) ?? []) : [];
      return {
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        description: cat.description,
        image: cat.image,
        parent_id: cat.parent_id,
        is_featured: cat.is_featured,
        children_count: childrenCount,
        is_leaf: isLeaf,
        accepts_products: isLeaf,
        products_count: Number(cat.direct_products_count) || 0,
        products,
      };
    };

    const all = categoriesRes.rows.map(mapCategory);
    const childrenByParent = new Map<number, any[]>();
    for (const cat of all) {
      if (cat.parent_id == null) continue;
      const list = childrenByParent.get(cat.parent_id) ?? [];
      list.push(cat);
      childrenByParent.set(cat.parent_id, list);
    }

    const data = all
      .filter((cat) => cat.parent_id == null)
      .map((cat) => {
        const children = childrenByParent.get(cat.id) ?? [];
        const productsCount = children.length
          ? children.reduce((sum, child) => sum + Number(child.products_count || 0), 0)
          : cat.products_count;
        return {
          ...cat,
          children_count: children.length,
          is_leaf: children.length === 0,
          accepts_products: children.length === 0,
          products_count: productsCount,
          children,
          products: children.length === 0 ? cat.products : [],
        };
      });

    ok(res, data);
  }),
);

const EFFECTIVE_PRICE_SQL = `
CASE
  WHEN p.sale_price IS NOT NULL
    AND (p.sale_starts_at IS NULL OR p.sale_starts_at <= NOW())
    AND (p.sale_ends_at IS NULL OR p.sale_ends_at >= NOW())
  THEN p.sale_price
  ELSE p.price
END`;

function categoryTreeCte(idParam: string) {
  return `
    WITH RECURSIVE category_tree AS (
      SELECT id FROM categories WHERE id = ${idParam}
      UNION ALL
      SELECT c.id
      FROM categories c
      INNER JOIN category_tree t ON c.parent_id = t.id
      WHERE c.is_active = TRUE
    )
  `;
}

/**
 * Brands and price bounds for products in this category (and its children)
 * GET /categories/:idOrSlug/filters
 */
router.get(
  '/:idOrSlug/filters',
  asyncWrapper(async (req, res) => {
    const key = req.params.idOrSlug;
    const category = await pool.query(
      `SELECT id FROM categories WHERE id::text = $1 OR slug = $1 LIMIT 1`,
      [key],
    );
    if (!category.rowCount) throw new HttpError(404, 'Category not found');
    const categoryId = category.rows[0].id;

    const brands = await pool.query(
      `${categoryTreeCte('$1')}
       SELECT b.id, b.name, b.slug, b.logo, COUNT(*)::int AS products_count
       FROM products p
       INNER JOIN brands b ON b.id = p.brand_id
       WHERE p.category_id IN (SELECT id FROM category_tree)
         AND p.status = 'active'
         AND p.is_active = TRUE
         AND (b.is_active IS NULL OR b.is_active = TRUE)
       GROUP BY b.id, b.name, b.slug, b.logo
       ORDER BY b.name ASC`,
      [categoryId],
    );

    const prices = await pool.query(
      `${categoryTreeCte('$1')}
       SELECT
         COALESCE(MIN(${EFFECTIVE_PRICE_SQL}), 0)::float AS min_price,
         COALESCE(MAX(${EFFECTIVE_PRICE_SQL}), 0)::float AS max_price
       FROM products p
       WHERE p.category_id IN (SELECT id FROM category_tree)
         AND p.status = 'active'
         AND p.is_active = TRUE`,
      [categoryId],
    );

    ok(res, {
      brands: brands.rows,
      price: {
        min: Number(prices.rows[0]?.min_price ?? 0),
        max: Number(prices.rows[0]?.max_price ?? 0),
      },
    });
  }),
);

/**
 * Products under a category — paginated (default 12 / page)
 * GET /categories/:idOrSlug/products?page=1&limit=12&brand_id=&sort=price&order=desc
 */
router.get(
  '/:idOrSlug/products',
  asyncWrapper(async (req, res) => {
    const key = req.params.idOrSlug;
    const category = await pool.query(
      `SELECT id, name, slug, description, image, parent_id, is_active, is_featured
       FROM categories
       WHERE id::text = $1 OR slug = $1
       LIMIT 1`,
      [key],
    );
    if (!category.rowCount) throw new HttpError(404, 'Category not found');
    const cat = category.rows[0];

    const query = PaginationQuery.extend({
      limit: z.coerce.number().int().min(1).max(100).default(12),
      sort: z.enum(['price', 'name', 'created_at', 'stock']).optional(),
      brand_id: z.coerce.number().int().positive().optional(),
      in_stock: z.enum(['true', 'false']).optional(),
      featured: z.enum(['true', 'false']).optional(),
      min_price: z.coerce.number().optional(),
      max_price: z.coerce.number().optional(),
    }).parse(req.query);

    const values: unknown[] = [cat.id];
    const where = [
      `p.category_id IN (SELECT id FROM category_tree)`,
      `p.status = 'active'`,
      `p.is_active = TRUE`,
    ];
    let i = 2;

    if (query.brand_id) {
      where.push(`p.brand_id = $${i++}`);
      values.push(query.brand_id);
    }
    if (query.min_price != null) {
      where.push(`(${EFFECTIVE_PRICE_SQL}) >= $${i++}`);
      values.push(query.min_price);
    }
    if (query.max_price != null) {
      where.push(`(${EFFECTIVE_PRICE_SQL}) <= $${i++}`);
      values.push(query.max_price);
    }
    if (query.in_stock === 'true') {
      where.push(`(p.stock - COALESCE(p.reserved_stock, 0)) > 0`);
    }
    if (query.featured === 'true') {
      where.push(`p.is_featured = TRUE`);
    }
    if (query.q) {
      where.push(
        `(p.name ILIKE $${i} OR p.sku ILIKE $${i} OR p.model_number ILIKE $${i} OR p.search_keywords ILIKE $${i})`,
      );
      values.push(`%${query.q}%`);
      i++;
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const treeSql = categoryTreeCte('$1');
    const count = await pool.query(
      `${treeSql} SELECT COUNT(*)::int AS total FROM products p ${whereSql}`,
      values,
    );

    const sortMap: Record<string, string> = {
      price: `(${EFFECTIVE_PRICE_SQL})`,
      name: 'p.name',
      created_at: 'p.created_at',
      stock: 'p.stock',
    };
    const sortCol = sortMap[query.sort || 'created_at'] || 'p.created_at';
    const order = query.order === 'asc' ? 'ASC' : 'DESC';

    values.push(query.limit, getOffset(query.page, query.limit));
    const result = await pool.query(
      `${treeSql}
       SELECT p.*, b.name AS brand_name, c.name AS category_name
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
       ${whereSql}
       ORDER BY ${sortCol} ${order}, p.id DESC
       LIMIT $${i++} OFFSET $${i}`,
      values,
    );

    const products = result.rows.map((p) => ({
      ...p,
      effective_price: effectiveProductPrice(p),
      available_stock: Math.max(0, Number(p.stock) - Number(p.reserved_stock || 0)),
    }));

    paginated(res, products, {
      total: count.rows[0].total,
      page: query.page,
      limit: query.limit,
    });
  }),
);

router.get(
  '/:idOrSlug',
  asyncWrapper(async (req, res) => {
    const key = req.params.idOrSlug;
    const result = await pool.query(
      `SELECT * FROM categories WHERE id::text = $1 OR slug = $1 LIMIT 1`,
      [key],
    );
    if (!result.rowCount) throw new HttpError(404, 'Category not found');
    const category = result.rows[0];
    const children = await pool.query(
      `SELECT c.*,
              (
                SELECT COUNT(*)::int FROM categories ch
                WHERE ch.parent_id = c.id AND ch.is_active = TRUE
              ) AS children_count,
              (
                SELECT COUNT(*)::int FROM products p
                WHERE p.category_id = c.id AND p.status = 'active' AND p.is_active = TRUE
              ) AS products_count
       FROM categories c
       WHERE c.parent_id = $1
       ORDER BY c.display_order ASC, c.name ASC`,
      [category.id],
    );
    const mappedChildren = children.rows.map((child) => ({
      ...child,
      is_leaf: Number(child.children_count) === 0,
      accepts_products: Number(child.children_count) === 0,
    }));
    ok(res, {
      ...category,
      children_count: mappedChildren.length,
      is_leaf: mappedChildren.length === 0,
      accepts_products: mappedChildren.length === 0,
      children: mappedChildren,
    });
  }),
);

router.post(
  '/',
  authMiddleware(['admin']),
  requirePermission('categories.manage'),
  handleCategoryImage,
  validate(CategoryFormBody),
  asyncWrapper(async (req, res) => {
    const body = req.body as z.infer<typeof CategoryFormBody>;
    const image = parseCategoryImage(req);

    if (body.parent_id) {
      await assertParentCanHaveSubcategory(body.parent_id);
    }

    const slug =
      body.slug ||
      (await uniqueSlug(body.name, async (s) => {
        const r = await pool.query('SELECT 1 FROM categories WHERE slug = $1', [s]);
        return (r.rowCount ?? 0) > 0;
      }));

    const result = await pool.query(
      `INSERT INTO categories
       (name, slug, description, image, parent_id, seo_title, seo_description, display_order, is_featured, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        body.name,
        slugify(slug),
        body.description ?? null,
        image ?? null,
        body.parent_id ?? null,
        body.seo_title ?? null,
        body.seo_description ?? null,
        body.display_order ?? 0,
        body.is_featured ?? false,
        body.is_active ?? true,
      ],
    );
    await writeAudit({
      actorId: req.user!.id,
      action: 'category.create',
      resourceType: 'category',
      resourceId: result.rows[0].id,
      after: result.rows[0],
    });
    created(res, result.rows[0]);
  }),
);

router.put(
  '/:id',
  authMiddleware(['admin']),
  requirePermission('categories.manage'),
  handleCategoryImage,
  validate(CategoryFormBody.partial()),
  asyncWrapper(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT * FROM categories WHERE id = $1', [id]);
    if (!existing.rowCount) throw new HttpError(404, 'Category not found');

    const body = req.body as Partial<z.infer<typeof CategoryFormBody>>;
    const image = parseCategoryImage(req);

    if (body.parent_id !== undefined) {
      if (await wouldCreateCycle(id, body.parent_id ?? null)) {
        throw new HttpError(400, 'Circular parent relationship is not allowed');
      }
      if (body.parent_id) {
        await assertParentCanHaveSubcategory(body.parent_id);
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const set = (col: string, val: unknown) => {
      sets.push(`${col} = $${i++}`);
      values.push(val);
    };

    if (body.name !== undefined) set('name', body.name);
    if (body.slug !== undefined) set('slug', slugify(body.slug));
    if (body.description !== undefined) set('description', body.description ?? null);
    if (body.parent_id !== undefined) set('parent_id', body.parent_id ?? null);
    if (body.seo_title !== undefined) set('seo_title', body.seo_title ?? null);
    if (body.seo_description !== undefined) set('seo_description', body.seo_description ?? null);
    if (body.display_order !== undefined) set('display_order', body.display_order);
    if (body.is_featured !== undefined) set('is_featured', body.is_featured);
    if (body.is_active !== undefined) set('is_active', body.is_active);
    if (image) set('image', image);

    if (!sets.length) throw new HttpError(400, 'No fields to update');
    sets.push('updated_at = NOW()');
    values.push(id);

    const result = await pool.query(
      `UPDATE categories SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    await writeAudit({
      actorId: req.user!.id,
      action: 'category.update',
      resourceType: 'category',
      resourceId: id,
      before: existing.rows[0],
      after: result.rows[0],
    });
    ok(res, result.rows[0]);
  }),
);

router.delete(
  '/:id',
  authMiddleware(['admin']),
  requirePermission('categories.manage'),
  asyncWrapper(async (req, res) => {
    const id = Number(req.params.id);
    const products = await pool.query(
      'SELECT COUNT(*)::int AS c FROM products WHERE category_id = $1',
      [id],
    );
    if (products.rows[0].c > 0) {
      throw new HttpError(
        400,
        'Category has products. Reassign or archive products before deleting.',
      );
    }
    const children = await pool.query(
      'SELECT COUNT(*)::int AS c FROM categories WHERE parent_id = $1',
      [id],
    );
    if (children.rows[0].c > 0) {
      throw new HttpError(400, 'Category has subcategories. Reassign them first.');
    }
    const result = await pool.query('DELETE FROM categories WHERE id = $1 RETURNING *', [id]);
    if (!result.rowCount) throw new HttpError(404, 'Category not found');
    await writeAudit({
      actorId: req.user!.id,
      action: 'category.delete',
      resourceType: 'category',
      resourceId: id,
      before: result.rows[0],
    });
    ok(res, { message: 'Category deleted' });
  }),
);
