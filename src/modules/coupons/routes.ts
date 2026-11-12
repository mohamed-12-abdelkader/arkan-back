import { Router } from 'express';
import { z } from 'zod';
import pool from '../../db/pool';
import { asyncWrapper, HttpError } from '../../utils';
import { authMiddleware, optionalAuth, requirePermission } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { created, ok, paginated } from '../../shared/response';
import { getOffset, PaginationQuery } from '../../shared/pagination';
import { writeAudit } from '../../services/audit';
import { validateCouponForAmount } from '../../services/coupons';

export const router = Router();

/** Admin create: code + percentage (simplest), optional extras */
const CouponFields = z.object({
  code: z.string().min(2).max(40),
  /** نسبة الخصم % أو مبلغ ثابت — الافتراضي للأدمن نسبة مئوية */
  value: z.number().positive(),
  type: z.enum(['fixed', 'percentage', 'free_shipping']).optional().default('percentage'),
  min_order_amount: z.number().nonnegative().optional().nullable(),
  max_discount: z.number().nonnegative().optional().nullable(),
  starts_at: z.string().optional().nullable(),
  ends_at: z.string().optional().nullable(),
  usage_limit: z.number().int().positive().optional().nullable(),
  per_customer_limit: z.number().int().positive().optional().nullable(),
  first_order_only: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

const CouponBody = CouponFields.superRefine((data, ctx) => {
  const type = data.type ?? 'percentage';
  if (type === 'percentage' && data.value > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'نسبة الخصم لا تتجاوز 100%',
      path: ['value'],
    });
  }
});

router.get(
  '/',
  authMiddleware(['admin']),
  requirePermission('coupons.manage'),
  asyncWrapper(async (req, res) => {
    const query = PaginationQuery.parse(req.query);
    const count = await pool.query('SELECT COUNT(*)::int AS total FROM coupons');
    const result = await pool.query(
      `SELECT * FROM coupons ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [query.limit, getOffset(query.page, query.limit)],
    );
    paginated(res, result.rows, {
      total: count.rows[0].total,
      page: query.page,
      limit: query.limit,
    });
  }),
);

/**
 * Public: preview / validate a coupon before payment
 * POST /coupons/validate { code, subtotal }
 */
router.post(
  '/validate',
  optionalAuth(),
  validate(
    z.object({
      code: z.string().min(1),
      subtotal: z.number().nonnegative(),
    }),
  ),
  asyncWrapper(async (req, res) => {
    const { code, subtotal } = req.body;
    const { coupon, discount } = await validateCouponForAmount(
      code,
      subtotal,
      req.user?.id ?? null,
    );
    ok(res, {
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      discount,
      subtotal,
      total_after_discount: Math.max(0, Number(subtotal) - Number(discount)).toFixed(2),
      message:
        coupon.type === 'percentage'
          ? `خصم ${coupon.value}%`
          : coupon.type === 'fixed'
            ? `خصم ${coupon.value} ج.م`
            : 'شحن مجاني',
    });
  }),
);

router.get(
  '/:id',
  authMiddleware(['admin']),
  requirePermission('coupons.manage'),
  asyncWrapper(async (req, res) => {
    const result = await pool.query('SELECT * FROM coupons WHERE id = $1', [req.params.id]);
    if (!result.rowCount) throw new HttpError(404, 'Coupon not found');
    ok(res, result.rows[0]);
  }),
);

router.post(
  '/',
  authMiddleware(['admin']),
  requirePermission('coupons.manage'),
  validate(CouponBody),
  asyncWrapper(async (req, res) => {
    const b = req.body as z.infer<typeof CouponBody>;
    const type = b.type ?? 'percentage';
    if (type === 'percentage' && Number(b.value) > 100) {
      throw new HttpError(400, 'نسبة الخصم لا تتجاوز 100%');
    }

    const existing = await pool.query(`SELECT id FROM coupons WHERE UPPER(code) = UPPER($1)`, [
      b.code,
    ]);
    if (existing.rowCount) throw new HttpError(409, 'كود الخصم موجود مسبقاً');

    const result = await pool.query(
      `INSERT INTO coupons
       (code, type, value, min_order_amount, max_discount, starts_at, ends_at,
        usage_limit, per_customer_limit, first_order_only, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        b.code.toUpperCase().trim(),
        type,
        b.value,
        b.min_order_amount ?? null,
        b.max_discount ?? null,
        b.starts_at || null,
        b.ends_at || null,
        b.usage_limit ?? null,
        b.per_customer_limit ?? null,
        b.first_order_only ?? false,
        b.is_active ?? true,
      ],
    );
    await writeAudit({
      actorId: req.user!.id,
      action: 'coupon.create',
      resourceType: 'coupon',
      resourceId: result.rows[0].id,
      after: result.rows[0],
    });
    created(res, result.rows[0]);
  }),
);

router.put(
  '/:id',
  authMiddleware(['admin']),
  requirePermission('coupons.manage'),
  validate(CouponFields.partial()),
  asyncWrapper(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT * FROM coupons WHERE id = $1', [id]);
    if (!existing.rowCount) throw new HttpError(404, 'Coupon not found');

    const body = { ...req.body } as Record<string, unknown>;
    if (typeof body.code === 'string') body.code = body.code.toUpperCase().trim();
    if (body.value != null && body.type === 'percentage' && Number(body.value) > 100) {
      throw new HttpError(400, 'نسبة الخصم لا تتجاوز 100%');
    }
    if (body.value != null && !body.type && existing.rows[0].type === 'percentage') {
      if (Number(body.value) > 100) throw new HttpError(400, 'نسبة الخصم لا تتجاوز 100%');
    }

    const allowed = [
      'code',
      'type',
      'value',
      'min_order_amount',
      'max_discount',
      'starts_at',
      'ends_at',
      'usage_limit',
      'per_customer_limit',
      'first_order_only',
      'is_active',
    ] as const;

    const keys = allowed.filter((k) => body[k] !== undefined);
    if (!keys.length) throw new HttpError(400, 'No fields');

    const updates = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => (body[k] === '' ? null : body[k]));
    values.push(id);

    const result = await pool.query(
      `UPDATE coupons SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );

    await writeAudit({
      actorId: req.user!.id,
      action: 'coupon.update',
      resourceType: 'coupon',
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
  requirePermission('coupons.manage'),
  asyncWrapper(async (req, res) => {
    const id = Number(req.params.id);
    const result = await pool.query('DELETE FROM coupons WHERE id = $1 RETURNING *', [id]);
    if (!result.rowCount) throw new HttpError(404, 'Coupon not found');
    await writeAudit({
      actorId: req.user!.id,
      action: 'coupon.delete',
      resourceType: 'coupon',
      resourceId: id,
      before: result.rows[0],
    });
    ok(res, { message: 'Coupon deleted', id });
  }),
);
