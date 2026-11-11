import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import pool from '../../db/pool';
import { asyncWrapper, HttpError } from '../../utils';
import { authMiddleware, optionalAuth, requirePermission } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { created, ok } from '../../shared/response';
import { addMoney, effectiveProductPrice, mulMoney, toMoney } from '../../shared/money';
import { checkBuildCompatibility } from '../compatibility/engine';
import { writeAudit } from '../../services/audit';
import { uniqueSlug } from '../../shared/slug';

export const router = Router();

const CreateBuild = z.object({
  name: z.string().min(1).optional(),
  template_id: z.number().int().positive().optional(),
  guest_token: z.string().optional(),
});

const COMPONENT_TYPES = [
  'cpu',
  'motherboard',
  'gpu',
  'psu',
  'case',
  'ram',
  'storage',
  'cooler',
] as const;

const AddItem = z.object({
  slot_id: z.number().int().positive().optional().nullable(),
  product_id: z.number().int().positive(),
  variant_id: z.number().int().positive().optional().nullable(),
  quantity: z.number().int().positive().default(1),
  guest_token: z.string().optional(),
});

const ComponentBody = z.object({
  name: z.string().min(1),
  component_type: z.enum(COMPONENT_TYPES),
  price: z.number().nonnegative(),
  stock: z.number().int().nonnegative().optional(),
  description: z.string().optional().nullable(),
  sku: z.string().min(1).optional().nullable(),
  specs: z.record(z.any()).optional(),
  is_active: z.boolean().optional(),
});

async function recalculateBuild(buildId: number) {
  const items = await pool.query(
    `SELECT bi.*, p.price, p.sale_price, p.sale_starts_at, p.sale_ends_at, p.component_type, p.specs, p.name, p.image, p.sku, p.status, p.is_active,
            p.stock, p.reserved_stock, s.name AS slot_name, s.max_quantity,
            pv.price AS variant_price, pv.stock AS variant_stock
     FROM pc_build_items bi
     JOIN products p ON p.id = bi.product_id
     LEFT JOIN build_slots s ON s.id = bi.slot_id
     LEFT JOIN product_variants pv ON pv.id = bi.variant_id
     WHERE bi.build_id = $1
     ORDER BY s.display_order NULLS LAST, bi.id`,
    [buildId],
  );

  let subtotal = '0.00';
  for (const item of items.rows) {
    const unit =
      item.variant_price != null
        ? toMoney(item.variant_price)
        : effectiveProductPrice(item);
    const line = mulMoney(unit, item.quantity);
    await pool.query('UPDATE pc_build_items SET unit_price = $1 WHERE id = $2', [unit, item.id]);
    subtotal = addMoney(subtotal, line);
  }

  await pool.query('UPDATE pc_builds SET subtotal = $1, updated_at = NOW() WHERE id = $2', [
    subtotal,
    buildId,
  ]);

  const compat = await checkBuildCompatibility(
    items.rows.map((i) => ({
      product_id: i.product_id,
      component_type: i.component_type,
      specs: i.specs,
    })),
  );

  return { items: items.rows, subtotal, compatibility: compat };
}

async function assertBuildAccess(buildId: number, userId?: number, guestToken?: string) {
  const result = await pool.query('SELECT * FROM pc_builds WHERE id = $1', [buildId]);
  if (!result.rowCount) throw new HttpError(404, 'Build not found');
  const build = result.rows[0];
  if (userId && build.user_id === userId) return build;
  if (guestToken && build.guest_token === guestToken) return build;
  if (!build.user_id && !build.guest_token) return build;
  throw new HttpError(403, 'Forbidden');
}

router.get(
  '/templates',
  asyncWrapper(async (_req, res) => {
    const templates = await pool.query(
      'SELECT * FROM build_templates WHERE is_active = TRUE ORDER BY display_order',
    );
    const slots = await pool.query(
      'SELECT * FROM build_slots ORDER BY display_order',
    );
    ok(
      res,
      templates.rows.map((t) => ({
        ...t,
        slots: slots.rows.filter((s) => s.template_id === t.id),
      })),
    );
  }),
);

function mapComponent(row: {
  id: number;
  price: string | number;
  sale_price?: string | number | null;
  sale_starts_at?: Date | null;
  sale_ends_at?: Date | null;
  stock?: number;
  reserved_stock?: number;
  [key: string]: unknown;
}) {
  return {
    ...row,
    effective_price: effectiveProductPrice(row),
    available_stock: Math.max(0, Number(row.stock || 0) - Number(row.reserved_stock || 0)),
  };
}

router.get(
  '/catalog',
  asyncWrapper(async (_req, res) => {
    const template = await pool.query(
      `SELECT id, name, slug, description FROM build_templates
       WHERE slug = 'custom-pc' AND is_active = TRUE LIMIT 1`,
    );
    if (!template.rowCount) throw new HttpError(404, 'Build template not found');

    const slots = await pool.query(
      `SELECT id, name, component_type, is_required, allow_multiple, min_quantity, max_quantity, can_skip, display_order
       FROM build_slots WHERE template_id = $1 ORDER BY display_order, id`,
      [template.rows[0].id],
    );
    const products = await pool.query(
      `SELECT id, name, slug, sku, price, sale_price, sale_starts_at, sale_ends_at,
              stock, reserved_stock, image, specs, component_type, short_description, description
       FROM products
       WHERE status = 'active' AND is_active = TRUE AND component_type IS NOT NULL
       ORDER BY price ASC, name ASC`,
    );
    const options = products.rows.map((row) => mapComponent(row));

    ok(res, {
      template: template.rows[0],
      slots: slots.rows.map((slot) => ({
        ...slot,
        options: options.filter((option) => option.component_type === slot.component_type),
      })),
    });
  }),
);

router.get(
  '/components',
  authMiddleware(['admin']),
  requirePermission('products.manage'),
  asyncWrapper(async (_req, res) => {
    const result = await pool.query(
      `SELECT id, name, slug, sku, price, stock, reserved_stock, description, specs,
              component_type, image, status, is_active, created_at
       FROM products
       WHERE component_type IS NOT NULL AND status <> 'archived'
       ORDER BY component_type, name`,
    );
    ok(res, result.rows.map((row) => mapComponent(row)));
  }),
);

router.post(
  '/components',
  authMiddleware(['admin']),
  requirePermission('products.manage'),
  validate(ComponentBody),
  asyncWrapper(async (req, res) => {
    const body = req.body;
    const base = body.sku || `${body.component_type}-${Date.now()}`;
    const slug = await uniqueSlug(base, async (candidate) => {
      const exists = await pool.query('SELECT 1 FROM products WHERE slug = $1', [candidate]);
      return Boolean(exists.rowCount);
    });
    const sku = body.sku || `BLD-${body.component_type.toUpperCase()}-${Date.now()}`;
    const inserted = await pool.query(
      `INSERT INTO products
        (name, slug, sku, description, price, stock, status, is_active, component_type, specs, track_inventory)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9::jsonb,TRUE)
       RETURNING *`,
      [
        body.name,
        slug,
        sku,
        body.description ?? null,
        body.price,
        body.stock ?? 0,
        body.is_active ?? true,
        body.component_type,
        JSON.stringify(body.specs ?? {}),
      ],
    );
    await writeAudit({
      actorId: req.user!.id,
      action: 'builder.component.create',
      resourceType: 'product',
      resourceId: inserted.rows[0].id,
      after: inserted.rows[0],
    });
    created(res, mapComponent(inserted.rows[0]));
  }),
);

router.patch(
  '/components/:id',
  authMiddleware(['admin']),
  requirePermission('products.manage'),
  validate(ComponentBody.partial()),
  asyncWrapper(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await pool.query(
      `SELECT * FROM products WHERE id = $1 AND component_type IS NOT NULL`,
      [id],
    );
    if (!existing.rowCount) throw new HttpError(404, 'Component not found');

    const body = req.body;
    const current = existing.rows[0];
    const updated = await pool.query(
      `UPDATE products SET
         name = $1,
         description = $2,
         price = $3,
         stock = $4,
         component_type = $5,
         specs = $6::jsonb,
         is_active = $7,
         status = CASE WHEN $7 THEN 'active' ELSE 'draft' END,
         sku = COALESCE($8, sku),
         updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        body.name ?? current.name,
        body.description === undefined ? current.description : body.description,
        body.price ?? current.price,
        body.stock ?? current.stock,
        body.component_type ?? current.component_type,
        JSON.stringify(body.specs ?? current.specs ?? {}),
        body.is_active ?? current.is_active,
        body.sku ?? null,
        id,
      ],
    );
    ok(res, mapComponent(updated.rows[0]));
  }),
);

router.delete(
  '/components/:id',
  authMiddleware(['admin']),
  requirePermission('products.manage'),
  asyncWrapper(async (req, res) => {
    const id = Number(req.params.id);
    const updated = await pool.query(
      `UPDATE products
       SET status = 'archived', is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND component_type IS NOT NULL
       RETURNING id`,
      [id],
    );
    if (!updated.rowCount) throw new HttpError(404, 'Component not found');
    ok(res, { id });
  }),
);

router.post(
  '/',
  optionalAuth(),
  validate(CreateBuild),
  asyncWrapper(async (req, res) => {
    const { name, template_id, guest_token } = req.body;
    let templateId = template_id;
    if (!templateId) {
      const t = await pool.query(`SELECT id FROM build_templates WHERE slug = 'custom-pc' LIMIT 1`);
      templateId = t.rows[0]?.id ?? null;
    }
    const result = await pool.query(
      `INSERT INTO pc_builds (user_id, guest_token, template_id, name, share_token)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        req.user?.id ?? null,
        req.user ? null : guest_token || crypto.randomUUID(),
        templateId,
        name || 'My Build',
        crypto.randomBytes(16).toString('hex'),
      ],
    );
    created(res, result.rows[0]);
  }),
);

router.get(
  '/:id',
  optionalAuth(),
  asyncWrapper(async (req, res) => {
    const build = await assertBuildAccess(
      Number(req.params.id),
      req.user?.id,
      req.query.guest_token as string | undefined,
    );
    const calc = await recalculateBuild(build.id);
    ok(res, { ...build, ...calc });
  }),
);

router.post(
  '/:id/items',
  optionalAuth(),
  validate(AddItem),
  asyncWrapper(async (req, res) => {
    const build = await assertBuildAccess(
      Number(req.params.id),
      req.user?.id,
      req.body.guest_token || (req.query.guest_token as string),
    );
    const { slot_id, product_id, variant_id, quantity } = req.body;

    const product = await pool.query(
      `SELECT * FROM products WHERE id = $1 AND status = 'active' AND is_active = TRUE`,
      [product_id],
    );
    if (!product.rowCount) throw new HttpError(400, 'Product not available');

    if (slot_id) {
      const slot = await pool.query('SELECT * FROM build_slots WHERE id = $1', [slot_id]);
      if (!slot.rowCount) throw new HttpError(400, 'Invalid slot');
      if (
        slot.rows[0].component_type &&
        product.rows[0].component_type &&
        slot.rows[0].component_type !== product.rows[0].component_type
      ) {
        throw new HttpError(400, 'Product component type does not match slot');
      }
      if (!slot.rows[0].allow_multiple) {
        await pool.query('DELETE FROM pc_build_items WHERE build_id = $1 AND slot_id = $2', [
          build.id,
          slot_id,
        ]);
      }
    }

    const unit = effectiveProductPrice(product.rows[0]);
    const inserted = await pool.query(
      `INSERT INTO pc_build_items (build_id, slot_id, product_id, variant_id, quantity, unit_price)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (build_id, slot_id, product_id, variant_id)
       DO UPDATE SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price
       RETURNING *`,
      [build.id, slot_id ?? null, product_id, variant_id ?? null, quantity, unit],
    );

    const calc = await recalculateBuild(build.id);
    if (calc.compatibility.overall === 'incompatible') {
      // Keep item but return compatibility errors — client must resolve before checkout
    }
    ok(res, { ...build, item: inserted.rows[0], ...calc });
  }),
);

router.delete(
  '/:id/items',
  optionalAuth(),
  asyncWrapper(async (req, res) => {
    const build = await assertBuildAccess(
      Number(req.params.id),
      req.user?.id,
      req.query.guest_token as string | undefined,
    );
    await pool.query('DELETE FROM pc_build_items WHERE build_id = $1', [build.id]);
    const calc = await recalculateBuild(build.id);
    ok(res, { ...build, ...calc });
  }),
);

router.patch(
  '/:id/items/:itemId',
  optionalAuth(),
  validate(
    z.object({
      quantity: z.number().int().positive(),
      guest_token: z.string().optional(),
    }),
  ),
  asyncWrapper(async (req, res) => {
    const build = await assertBuildAccess(
      Number(req.params.id),
      req.user?.id,
      req.body.guest_token as string | undefined,
    );
    const current = await pool.query(
      `SELECT bi.id, s.max_quantity
       FROM pc_build_items bi
       LEFT JOIN build_slots s ON s.id = bi.slot_id
       WHERE bi.id = $1 AND bi.build_id = $2`,
      [req.params.itemId, build.id],
    );
    if (!current.rowCount) throw new HttpError(404, 'Build item not found');
    const max = Number(current.rows[0].max_quantity || 1);
    if (req.body.quantity > max) {
      throw new HttpError(400, `الحد الأقصى للكمية هو ${max}`);
    }
    await pool.query('UPDATE pc_build_items SET quantity = $1 WHERE id = $2', [
      req.body.quantity,
      current.rows[0].id,
    ]);
    const calc = await recalculateBuild(build.id);
    ok(res, { ...build, ...calc });
  }),
);

router.delete(
  '/:id/items/:itemId',
  optionalAuth(),
  asyncWrapper(async (req, res) => {
    const build = await assertBuildAccess(
      Number(req.params.id),
      req.user?.id,
      req.query.guest_token as string | undefined,
    );
    await pool.query('DELETE FROM pc_build_items WHERE id = $1 AND build_id = $2', [
      req.params.itemId,
      build.id,
    ]);
    const calc = await recalculateBuild(build.id);
    ok(res, { ...build, ...calc });
  }),
);

router.post(
  '/:id/validate',
  optionalAuth(),
  asyncWrapper(async (req, res) => {
    const build = await assertBuildAccess(
      Number(req.params.id),
      req.user?.id,
      req.query.guest_token as string | undefined,
    );
    const calc = await recalculateBuild(build.id);
    ok(res, { ...build, ...calc });
  }),
);

router.post(
  '/:id/duplicate',
  optionalAuth(),
  asyncWrapper(async (req, res) => {
    const build = await assertBuildAccess(
      Number(req.params.id),
      req.user?.id,
      req.query.guest_token as string | undefined,
    );
    const copy = await pool.query(
      `INSERT INTO pc_builds (user_id, guest_token, template_id, name, share_token, status)
       VALUES ($1,$2,$3,$4,$5,'draft') RETURNING *`,
      [
        req.user?.id ?? null,
        req.user ? null : crypto.randomUUID(),
        build.template_id,
        `${build.name} (copy)`,
        crypto.randomBytes(16).toString('hex'),
      ],
    );
    await pool.query(
      `INSERT INTO pc_build_items (build_id, slot_id, product_id, variant_id, quantity, unit_price)
       SELECT $1, slot_id, product_id, variant_id, quantity, unit_price
       FROM pc_build_items WHERE build_id = $2`,
      [copy.rows[0].id, build.id],
    );
    const calc = await recalculateBuild(copy.rows[0].id);
    created(res, { ...copy.rows[0], ...calc });
  }),
);

router.get(
  '/share/:token',
  asyncWrapper(async (req, res) => {
    const result = await pool.query('SELECT * FROM pc_builds WHERE share_token = $1', [
      req.params.token,
    ]);
    if (!result.rowCount) throw new HttpError(404, 'Build not found');
    const calc = await recalculateBuild(result.rows[0].id);
    ok(res, { ...result.rows[0], ...calc });
  }),
);

// Admin: compatibility override
router.post(
  '/compatibility/overrides',
  authMiddleware(['admin']),
  requirePermission('compatibility.override'),
  validate(
    z.object({
      left_product_id: z.number().int().positive(),
      right_product_id: z.number().int().positive(),
      result: z.enum(['compatible', 'incompatible', 'uncertain', 'needs_verification']),
      reason: z.string().min(3),
    }),
  ),
  asyncWrapper(async (req, res) => {
    const { left_product_id, right_product_id, result, reason } = req.body;
    const row = await pool.query(
      `INSERT INTO compatibility_overrides
       (left_product_id, right_product_id, result, reason, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (left_product_id, right_product_id)
       DO UPDATE SET result = EXCLUDED.result, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by
       RETURNING *`,
      [left_product_id, right_product_id, result, reason, req.user!.id],
    );
    await writeAudit({
      actorId: req.user!.id,
      action: 'compatibility.override',
      resourceType: 'compatibility_override',
      resourceId: row.rows[0].id,
      after: row.rows[0],
    });
    created(res, row.rows[0]);
  }),
);
