import { Router } from 'express';
import { z } from 'zod';
import pool from '../../db/pool';
import { asyncWrapper, HttpError, publicUploadPath, uploadProductImages } from '../../utils';
import { authMiddleware, requirePermission } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { created, ok, paginated } from '../../shared/response';
import { getOffset, PaginationQuery } from '../../shared/pagination';
import { uniqueSlug } from '../../shared/slug';
import { effectiveProductPrice, toMoney } from '../../shared/money';
import { writeAudit } from '../../services/audit';
import { withTransaction } from '../../shared/db';
import { assertLeafCategoryForProduct } from '../../services/categories';

export const router = Router();

/** Coerce multipart form fields (strings) into numbers / nulls */
function formNumber(min = 0, opts?: { int?: boolean; positive?: boolean }) {
  return z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v, ctx) => {
      if (v === '' || v === null || v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid number' });
        return z.NEVER;
      }
      if (opts?.int && !Number.isInteger(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be an integer' });
        return z.NEVER;
      }
      if (opts?.positive && n <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be positive' });
        return z.NEVER;
      }
      if (n < min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Must be >= ${min}` });
        return z.NEVER;
      }
      return n;
    });
}

/**
 * Simple product form fields:
 * name, description?, price?, discount?, cost_price?, stock?,
 * category_id?, brand_id?, status?, + images files
 */
const ProductFormBody = z.object({
  name: z.string().min(1, 'اسم المنتج مطلوب'),
  description: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v === '' || v == null ? undefined : v)),
  price: formNumber(0),
  /** الخصم = سعر التخفيض (sale_price) */
  discount: formNumber(0),
  cost_price: formNumber(0),
  stock: formNumber(0, { int: true }),
  category_id: formNumber(1, { int: true, positive: true }),
  brand_id: formNumber(1, { int: true, positive: true }),
  status: z
    .union([z.enum(['draft', 'active', 'archived']), z.literal('')])
    .optional()
    .transform((v) => (v === '' || v == null ? undefined : v)),
});

const VariantBody = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  attributes: z.record(z.any()).optional(),
  price: z.number().nonnegative().optional().nullable(),
  cost_price: z.number().nonnegative().optional().nullable(),
  stock: z.number().int().nonnegative().optional(),
  barcode: z.string().optional().nullable(),
  image: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
});

function filesToUrls(files?: Express.Multer.File[]) {
  if (!files?.length) return [] as string[];
  return files.map((f) => publicUploadPath('products', f.filename));
}

router.get(
  '/',
  asyncWrapper(async (req, res) => {
    const query = PaginationQuery.extend({
      category_id: z.coerce.number().optional(),
      brand_id: z.coerce.number().optional(),
      component_type: z.string().optional(),
      status: z.enum(['draft', 'active', 'archived']).optional(),
      min_price: z.coerce.number().optional(),
      max_price: z.coerce.number().optional(),
      in_stock: z.enum(['true', 'false']).optional(),
      featured: z.enum(['true', 'false']).optional(),
    }).parse(req.query);

    const values: unknown[] = [];
    const where: string[] = [];
    let i = 1;

    if (!query.status) {
      where.push(`p.status = 'active'`);
      where.push(`p.is_active = TRUE`);
    } else {
      where.push(`p.status = $${i++}`);
      values.push(query.status);
    }

    if (query.category_id) {
      where.push(`p.category_id = $${i++}`);
      values.push(query.category_id);
    }
    if (query.brand_id) {
      where.push(`p.brand_id = $${i++}`);
      values.push(query.brand_id);
    }
    if (query.component_type) {
      where.push(`p.component_type = $${i++}`);
      values.push(query.component_type);
    }
    if (query.min_price != null) {
      where.push(`p.price >= $${i++}`);
      values.push(query.min_price);
    }
    if (query.max_price != null) {
      where.push(`p.price <= $${i++}`);
      values.push(query.max_price);
    }
    if (query.in_stock === 'true') {
      where.push(`(p.stock - p.reserved_stock) > 0`);
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

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM products p ${whereSql}`,
      values,
    );

    const sortMap: Record<string, string> = {
      price: 'p.price',
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
       ORDER BY ${sortCol} ${order}
       LIMIT $${i++} OFFSET $${i}`,
      values,
    );

    const data = result.rows.map((p) => ({
      ...p,
      effective_price: effectiveProductPrice(p),
      available_stock: Math.max(0, Number(p.stock) - Number(p.reserved_stock || 0)),
    }));

    paginated(res, data, { total: count.rows[0].total, page: query.page, limit: query.limit });
  }),
);

/**
 * Most requested / mixed showcase — active products from all categories in random order
 * GET /products/popular?page=1&limit=12
 */
router.get(
  '/popular',
  asyncWrapper(async (req, res) => {
    const query = PaginationQuery.extend({
      limit: z.coerce.number().int().min(1).max(100).default(12),
      in_stock: z.enum(['true', 'false']).optional(),
      seed: z.string().min(1).max(64).optional(),
    }).parse(req.query);

    const values: unknown[] = [];
    // Exclude PC builder parts (cpu/gpu/ram/...) — storefront products only
    const where = [`p.status = 'active'`, `p.is_active = TRUE`, `p.component_type IS NULL`];
    let i = 1;

    if (query.in_stock === 'true') {
      where.push(`(p.stock - COALESCE(p.reserved_stock, 0)) > 0`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM products p ${whereSql}`,
      values,
    );

    // Stable-ish shuffle per seed so pagination doesn't reshuffle mid-scroll.
    // Without seed: fresh random order on every request.
    const orderSql = query.seed ? `ORDER BY md5(p.id::text || $${i++})` : `ORDER BY random()`;
    if (query.seed) values.push(query.seed);

    values.push(query.limit, getOffset(query.page, query.limit));
    const result = await pool.query(
      `SELECT p.*, b.name AS brand_name, c.name AS category_name
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
       ${whereSql}
       ${orderSql}
       LIMIT $${i++} OFFSET $${i}`,
      values,
    );

    const data = result.rows.map((p) => ({
      ...p,
      effective_price: effectiveProductPrice(p),
      available_stock: Math.max(0, Number(p.stock) - Number(p.reserved_stock || 0)),
    }));

    paginated(res, data, {
      total: count.rows[0].total,
      page: query.page,
      limit: query.limit,
    });
  }),
);

/**
 * Product details — by id or slug
 * GET /products/:idOrSlug
 */
router.get(
  '/:idOrSlug',
  asyncWrapper(async (req, res) => {
    const result = await pool.query(
      `SELECT p.*,
              b.id AS brand_id_join, b.name AS brand_name, b.logo AS brand_logo, b.slug AS brand_slug,
              c.id AS category_id_join, c.name AS category_name, c.slug AS category_slug
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id::text = $1 OR p.slug = $1
       LIMIT 1`,
      [req.params.idOrSlug],
    );
    if (!result.rowCount) throw new HttpError(404, 'Product not found');
    const row = result.rows[0];

    const images = await pool.query(
      'SELECT id, url, position FROM product_images WHERE product_id = $1 ORDER BY position',
      [row.id],
    );
    const variants = await pool.query(
      `SELECT id, sku, name, attributes, price, cost_price, stock, barcode, image, is_active
       FROM product_variants WHERE product_id = $1 ORDER BY id`,
      [row.id],
    );

    const {
      brand_id_join,
      brand_name,
      brand_logo,
      brand_slug,
      category_id_join,
      category_name,
      category_slug,
      ...product
    } = row;

    ok(res, {
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      price: product.price,
      discount: product.sale_price,
      cost_price: product.cost_price,
      effective_price: effectiveProductPrice(product),
      stock: product.stock,
      available_stock: Math.max(0, Number(product.stock) - Number(product.reserved_stock || 0)),
      status: product.status,
      is_active: product.is_active,
      image: product.image,
      images: images.rows,
      brand: product.brand_id
        ? {
            id: brand_id_join,
            name: brand_name,
            slug: brand_slug,
            logo: brand_logo,
          }
        : null,
      category: product.category_id
        ? {
            id: category_id_join,
            name: category_name,
            slug: category_slug,
          }
        : null,
      variants: variants.rows,
      created_at: product.created_at,
      updated_at: product.updated_at,
    });
  }),
);

/**
 * Create product — multipart/form-data
 * Fields: name, description?, price?, discount?, cost_price?, stock?,
 *         category_id?, brand_id?, status?
 * Files:  images (multiple)
 */
router.post(
  '/',
  authMiddleware(['admin']),
  requirePermission('products.manage'),
  (req, res, next) => {
    uploadProductImages(req, res, (err) => {
      if (err) return next(new HttpError(400, err.message || 'Image upload failed'));
      next();
    });
  },
  validate(ProductFormBody),
  asyncWrapper(async (req, res) => {
    const body = req.body as z.infer<typeof ProductFormBody>;
    const imageUrls = filesToUrls(req.files as Express.Multer.File[] | undefined);

    await assertLeafCategoryForProduct(body.category_id ?? null);

    const slug = await uniqueSlug(body.name, async (s) => {
      const r = await pool.query('SELECT 1 FROM products WHERE slug = $1', [s]);
      return (r.rowCount ?? 0) > 0;
    });

    const salePrice = body.discount != null ? toMoney(body.discount) : null;
    const mainImage = imageUrls[0] ?? null;

    const product = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO products (
          name, slug, category_id, brand_id, description,
          price, cost_price, sale_price, stock, image, status, is_active
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)
        RETURNING *`,
        [
          body.name,
          slug,
          body.category_id ?? null,
          body.brand_id ?? null,
          body.description ?? null,
          toMoney(body.price ?? 0),
          body.cost_price != null ? toMoney(body.cost_price) : null,
          salePrice,
          body.stock ?? 0,
          mainImage,
          body.status ?? 'active',
        ],
      );

      const createdProduct = result.rows[0];
      for (const [idx, url] of imageUrls.entries()) {
        await client.query(
          'INSERT INTO product_images (product_id, url, position) VALUES ($1,$2,$3)',
          [createdProduct.id, url, idx],
        );
      }
      return createdProduct;
    });

    const images = await pool.query(
      'SELECT * FROM product_images WHERE product_id = $1 ORDER BY position',
      [product.id],
    );

    await writeAudit({
      actorId: req.user!.id,
      action: 'product.create',
      resourceType: 'product',
      resourceId: product.id,
      after: product,
    });

    created(res, {
      ...product,
      discount: product.sale_price,
      images: images.rows,
    });
  }),
);

/**
 * Update product — multipart/form-data (same fields; images optional append)
 */
router.put(
  '/:id',
  authMiddleware(['admin']),
  requirePermission('products.manage'),
  (req, res, next) => {
    uploadProductImages(req, res, (err) => {
      if (err) return next(new HttpError(400, err.message || 'Image upload failed'));
      next();
    });
  },
  validate(ProductFormBody.partial()),
  asyncWrapper(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (!existing.rowCount) throw new HttpError(404, 'Product not found');

    const body = req.body as Partial<z.infer<typeof ProductFormBody>>;
    const imageUrls = filesToUrls(req.files as Express.Multer.File[] | undefined);

    if (body.category_id !== undefined) {
      await assertLeafCategoryForProduct(body.category_id ?? null);
    }

    if (
      (body.price != null || body.discount != null || body.cost_price != null) &&
      req.user!.role !== 'admin'
    ) {
      const perms = new Set(req.user!.permissions ?? []);
      if (!perms.has('products.price')) {
        throw new HttpError(403, 'Missing products.price permission');
      }
    }

    const result = await withTransaction(async (client) => {
      const sets: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      const set = (col: string, val: unknown) => {
        sets.push(`${col} = $${idx++}`);
        values.push(val);
      };

      if (body.name !== undefined) set('name', body.name);
      if (body.description !== undefined) set('description', body.description ?? null);
      if (body.price !== undefined && body.price !== null) set('price', toMoney(body.price));
      if (body.discount !== undefined) {
        set('sale_price', body.discount != null ? toMoney(body.discount) : null);
      }
      if (body.cost_price !== undefined) {
        set('cost_price', body.cost_price != null ? toMoney(body.cost_price) : null);
      }
      if (body.stock !== undefined && body.stock !== null) set('stock', body.stock);
      if (body.category_id !== undefined) set('category_id', body.category_id);
      if (body.brand_id !== undefined) set('brand_id', body.brand_id);
      if (body.status !== undefined) {
        set('status', body.status);
        if (body.status === 'archived') set('is_active', false);
        else if (body.status === 'active') set('is_active', true);
      }
      if (imageUrls.length) set('image', imageUrls[0]);

      if (!sets.length && !imageUrls.length) {
        throw new HttpError(400, 'No fields to update');
      }

      let row = existing.rows[0];
      if (sets.length) {
        sets.push('updated_at = NOW()');
        values.push(id);
        const updated = await client.query(
          `UPDATE products SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
          values,
        );
        row = updated.rows[0];
      }

      if (imageUrls.length) {
        const maxPos = await client.query(
          'SELECT COALESCE(MAX(position), -1)::int AS m FROM product_images WHERE product_id = $1',
          [id],
        );
        let pos = Number(maxPos.rows[0].m) + 1;
        for (const url of imageUrls) {
          await client.query(
            'INSERT INTO product_images (product_id, url, position) VALUES ($1,$2,$3)',
            [id, url, pos++],
          );
        }
        if (!sets.some((s) => s.startsWith('image ='))) {
          await client
            .query('UPDATE products SET image = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [
              imageUrls[0],
              id,
            ])
            .then((r) => {
              row = r.rows[0];
            });
        }
      }

      return row;
    });

    const images = await pool.query(
      'SELECT * FROM product_images WHERE product_id = $1 ORDER BY position',
      [id],
    );

    await writeAudit({
      actorId: req.user!.id,
      action: 'product.update',
      resourceType: 'product',
      resourceId: id,
      before: existing.rows[0],
      after: result,
    });

    ok(res, { ...result, discount: result.sale_price, images: images.rows });
  }),
);

router.post(
  '/:id/variants',
  authMiddleware(['admin']),
  requirePermission('products.manage'),
  validate(VariantBody),
  asyncWrapper(async (req, res) => {
    const productId = Number(req.params.id);
    const product = await pool.query('SELECT id FROM products WHERE id = $1', [productId]);
    if (!product.rowCount) throw new HttpError(404, 'Product not found');

    const body = req.body;
    const dup = await pool.query(
      'SELECT id FROM product_variants WHERE sku = $1 UNION SELECT id FROM products WHERE sku = $1',
      [body.sku],
    );
    if (dup.rowCount) throw new HttpError(409, 'Duplicate SKU');

    const result = await pool.query(
      `INSERT INTO product_variants
       (product_id, sku, name, attributes, price, cost_price, stock, barcode, image, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        productId,
        body.sku,
        body.name,
        JSON.stringify(body.attributes ?? {}),
        body.price != null ? toMoney(body.price) : null,
        body.cost_price != null ? toMoney(body.cost_price) : null,
        body.stock ?? 0,
        body.barcode ?? null,
        body.image ?? null,
        body.is_active ?? true,
      ],
    );
    created(res, result.rows[0]);
  }),
);

/**
 * Admin delete product
 * - Default: soft delete (archive) — disappears from catalog, keeps order history
 * - ?permanent=true: hard delete only if product is not used in any order
 */
router.delete(
  '/:id',
  authMiddleware(['admin']),
  requirePermission('products.manage'),
  asyncWrapper(async (req, res) => {
    const id = Number(req.params.id);
    const permanent = req.query.permanent === 'true' || req.query.permanent === '1';

    const existing = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (!existing.rowCount) throw new HttpError(404, 'Product not found');

    if (permanent) {
      const used = await pool.query(
        'SELECT COUNT(*)::int AS c FROM order_items WHERE product_id = $1',
        [id],
      );
      if (used.rows[0].c > 0) {
        throw new HttpError(
          400,
          'Cannot permanently delete: product exists in orders. Use soft delete instead.',
        );
      }

      await withTransaction(async (client) => {
        await client.query('DELETE FROM product_images WHERE product_id = $1', [id]);
        await client.query('DELETE FROM product_variants WHERE product_id = $1', [id]);
        await client.query('DELETE FROM cart_lines WHERE product_id = $1', [id]);
        await client.query('DELETE FROM wishlists WHERE product_id = $1', [id]);
        await client.query('DELETE FROM product_reviews WHERE product_id = $1', [id]);
        // build items reference products with RESTRICT — block if used in builds
        const inBuilds = await client.query(
          'SELECT COUNT(*)::int AS c FROM pc_build_items WHERE product_id = $1',
          [id],
        );
        if (inBuilds.rows[0].c > 0) {
          throw new HttpError(
            400,
            'Cannot permanently delete: product is used in PC builds. Soft delete instead.',
          );
        }
        await client.query('DELETE FROM products WHERE id = $1', [id]);
      });

      await writeAudit({
        actorId: req.user!.id,
        action: 'product.delete.permanent',
        resourceType: 'product',
        resourceId: id,
        before: existing.rows[0],
      });

      return ok(res, {
        message: 'Product permanently deleted',
        id,
        permanent: true,
      });
    }

    const result = await pool.query(
      `UPDATE products SET status = 'archived', is_active = FALSE, updated_at = NOW()
       WHERE id = $1 RETURNING id, name, status, is_active`,
      [id],
    );

    await writeAudit({
      actorId: req.user!.id,
      action: 'product.delete',
      resourceType: 'product',
      resourceId: id,
      before: existing.rows[0],
      after: result.rows[0],
    });

    ok(res, {
      message: 'Product deleted',
      id,
      permanent: false,
      status: 'archived',
    });
  }),
);
