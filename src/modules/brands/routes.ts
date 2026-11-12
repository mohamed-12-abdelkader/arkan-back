import { Router } from 'express';
import { z } from 'zod';
import pool from '../../db/pool';
import { asyncWrapper, HttpError, publicUploadPath, uploadBrandLogo } from '../../utils';
import { authMiddleware, requirePermission } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { created, ok, paginated } from '../../shared/response';
import { getOffset, PaginationQuery } from '../../shared/pagination';
import { uniqueSlug } from '../../shared/slug';
import { writeAudit } from '../../services/audit';
import { effectiveProductPrice } from '../../shared/money';

export const router = Router();

const EFFECTIVE_PRICE_SQL = `
CASE
  WHEN p.sale_price IS NOT NULL
    AND (p.sale_starts_at IS NULL OR p.sale_starts_at <= NOW())
    AND (p.sale_ends_at IS NULL OR p.sale_ends_at >= NOW())
  THEN p.sale_price
  ELSE p.price
END`;

const BrandFormBody = z.object({
  name: z.string().min(1, 'اسم البراند مطلوب'),
  description: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v === '' || v == null ? undefined : v)),
  website: z
    .string()
    .optional()
    .nullable()
    .transform((v, ctx) => {
      if (v === '' || v == null) return undefined;
      const parsed = z.string().url().safeParse(v);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid website URL' });
        return z.NEVER;
      }
      return parsed.data;
    }),
  is_active: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0', ''])])
    .optional()
    .transform((v) => {
      if (v === '' || v == null) return undefined;
      if (v === true || v === 'true' || v === '1') return true;
      if (v === false || v === 'false' || v === '0') return false;
      return undefined;
    }),
});

function parseLogo(req: { file?: Express.Multer.File }): string | undefined {
  if (!req.file) return undefined;
  return publicUploadPath('brands', req.file.filename);
}

function handleLogoUpload(req: any, res: any, next: any) {
  uploadBrandLogo(req, res, (err: any) => {
    if (err) return next(new HttpError(400, err.message || 'Logo upload failed'));
    next();
  });
}

/** Public list */
router.get(
  '/',
  asyncWrapper(async (req, res) => {
    const query = PaginationQuery.extend({
      is_active: z.enum(['true', 'false']).optional(),
    }).parse(req.query);

    const values: unknown[] = [];
    const where: string[] = [];
    let i = 1;

    if (query.q) {
      where.push(`(name ILIKE $${i} OR slug ILIKE $${i})`);
      values.push(`%${query.q}%`);
      i++;
    }
    if (query.is_active) {
      where.push(`is_active = $${i++}`);
      values.push(query.is_active === 'true');
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM brands ${whereSql}`, values);
    values.push(query.limit, getOffset(query.page, query.limit));
    const result = await pool.query(
      `SELECT * FROM brands ${whereSql} ORDER BY name ASC LIMIT $${i++} OFFSET $${i}`,
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
 * Filter metadata for a brand page — categories + price range
 * GET /brands/:idOrSlug/filters
 */
router.get(
  '/:idOrSlug/filters',
  asyncWrapper(async (req, res) => {
    const key = req.params.idOrSlug;
    const brand = await pool.query(
      `SELECT id FROM brands WHERE id::text = $1 OR slug = $1 LIMIT 1`,
      [key],
    );
    if (!brand.rowCount) throw new HttpError(404, 'Brand not found');
    const brandId = brand.rows[0].id;

    const categories = await pool.query(
      `SELECT c.id, c.name, c.slug, c.image, COUNT(*)::int AS products_count
       FROM products p
       INNER JOIN categories c ON c.id = p.category_id
       WHERE p.brand_id = $1
         AND p.status = 'active'
         AND p.is_active = TRUE
         AND (c.is_active IS NULL OR c.is_active = TRUE)
       GROUP BY c.id, c.name, c.slug, c.image
       ORDER BY c.name ASC`,
      [brandId],
    );

    const prices = await pool.query(
      `SELECT
         COALESCE(MIN(${EFFECTIVE_PRICE_SQL}), 0)::float AS min_price,
         COALESCE(MAX(${EFFECTIVE_PRICE_SQL}), 0)::float AS max_price
       FROM products p
       WHERE p.brand_id = $1
         AND p.status = 'active'
         AND p.is_active = TRUE`,
      [brandId],
    );

    ok(res, {
      categories: categories.rows,
      price: {
        min: Number(prices.rows[0]?.min_price ?? 0),
        max: Number(prices.rows[0]?.max_price ?? 0),
      },
    });
  }),
);

/**
 * Products of a brand — paginated (default 12 / page)
 * GET /brands/:idOrSlug/products?page=1&limit=12
 */
router.get(
  '/:idOrSlug/products',
  asyncWrapper(async (req, res) => {
    const key = req.params.idOrSlug;
    const brand = await pool.query(
      `SELECT id, name, slug, description, logo, website, is_active
       FROM brands
       WHERE id::text = $1 OR slug = $1
       LIMIT 1`,
      [key],
    );
    if (!brand.rowCount) throw new HttpError(404, 'Brand not found');
    const brandRow = brand.rows[0];

    const query = PaginationQuery.extend({
      limit: z.coerce.number().int().min(1).max(100).default(12),
      sort: z.enum(['price', 'name', 'created_at', 'stock']).optional(),
      category_id: z.coerce.number().int().positive().optional(),
      in_stock: z.enum(['true', 'false']).optional(),
      featured: z.enum(['true', 'false']).optional(),
      min_price: z.coerce.number().optional(),
      max_price: z.coerce.number().optional(),
    }).parse(req.query);

    const values: unknown[] = [brandRow.id];
    const where = [`p.brand_id = $1`, `p.status = 'active'`, `p.is_active = TRUE`];
    let i = 2;

    if (query.category_id) {
      where.push(`p.category_id = $${i++}`);
      values.push(query.category_id);
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
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM products p ${whereSql}`,
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
      `SELECT p.*, b.name AS brand_name, c.name AS category_name
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
    const result = await pool.query(
      `SELECT * FROM brands WHERE id::text = $1 OR slug = $1 LIMIT 1`,
      [req.params.idOrSlug],
    );
    if (!result.rowCount) throw new HttpError(404, 'Brand not found');
    ok(res, result.rows[0]);
  }),
);

/** Admin: create brand (+ optional logo from device) */
router.post(
  '/',
  authMiddleware(['admin']),
  requirePermission('brands.manage'),
  handleLogoUpload,
  validate(BrandFormBody),
  asyncWrapper(async (req, res) => {
    const body = req.body as z.infer<typeof BrandFormBody>;
    const logo = parseLogo(req);

    const slug = await uniqueSlug(body.name, async (s) => {
      const r = await pool.query('SELECT 1 FROM brands WHERE slug = $1', [s]);
      return (r.rowCount ?? 0) > 0;
    });

    const result = await pool.query(
      `INSERT INTO brands (name, slug, description, logo, website, is_active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        body.name,
        slug,
        body.description ?? null,
        logo ?? null,
        body.website ?? null,
        body.is_active ?? true,
      ],
    );

    await writeAudit({
      actorId: req.user!.id,
      action: 'brand.create',
      resourceType: 'brand',
      resourceId: result.rows[0].id,
      after: result.rows[0],
    });
    created(res, result.rows[0]);
  }),
);

/** Admin: update brand */
router.put(
  '/:id',
  authMiddleware(['admin']),
  requirePermission('brands.manage'),
  handleLogoUpload,
  validate(BrandFormBody.partial()),
  asyncWrapper(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT * FROM brands WHERE id = $1', [id]);
    if (!existing.rowCount) throw new HttpError(404, 'Brand not found');

    const body = req.body as Partial<z.infer<typeof BrandFormBody>>;
    const logo = parseLogo(req);

    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const set = (col: string, val: unknown) => {
      sets.push(`${col} = $${i++}`);
      values.push(val);
    };

    if (body.name !== undefined) {
      set('name', body.name);
      const newSlug = await uniqueSlug(body.name, async (s) => {
        const r = await pool.query('SELECT 1 FROM brands WHERE slug = $1 AND id <> $2', [s, id]);
        return (r.rowCount ?? 0) > 0;
      });
      set('slug', newSlug);
    }
    if (body.description !== undefined) set('description', body.description ?? null);
    if (body.website !== undefined) set('website', body.website ?? null);
    if (body.is_active !== undefined) set('is_active', body.is_active);
    if (logo) set('logo', logo);

    if (!sets.length) throw new HttpError(400, 'No fields to update');
    sets.push('updated_at = NOW()');
    values.push(id);

    const result = await pool.query(
      `UPDATE brands SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );

    await writeAudit({
      actorId: req.user!.id,
      action: 'brand.update',
      resourceType: 'brand',
      resourceId: id,
      before: existing.rows[0],
      after: result.rows[0],
    });
    ok(res, result.rows[0]);
  }),
);

/** Admin: delete brand (unlinks products first) */
router.delete(
  '/:id',
  authMiddleware(['admin']),
  requirePermission('brands.manage'),
  asyncWrapper(async (req, res) => {
    const id = Number(req.params.id);
    await pool.query('UPDATE products SET brand_id = NULL WHERE brand_id = $1', [id]);
    const result = await pool.query('DELETE FROM brands WHERE id = $1 RETURNING *', [id]);
    if (!result.rowCount) throw new HttpError(404, 'Brand not found');

    await writeAudit({
      actorId: req.user!.id,
      action: 'brand.delete',
      resourceType: 'brand',
      resourceId: id,
      before: result.rows[0],
    });
    ok(res, { message: 'Brand deleted', id });
  }),
);
