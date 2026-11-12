import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import pool from '../../db/pool';
import { asyncWrapper, config, HttpError } from '../../utils';
import { authMiddleware, optionalAuth } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { ok } from '../../shared/response';
import { addMoney, effectiveProductPrice, mulMoney, toMoney } from '../../shared/money';
import { withTransaction } from '../../shared/db';
import { checkBuildCompatibility } from '../compatibility/engine';
import { validateCouponForAmount } from '../../services/coupons';

export const router = Router();

const AddLine = z.object({
  product_id: z.number().int().positive().optional(),
  variant_id: z.number().int().positive().optional().nullable(),
  build_id: z.number().int().positive().optional(),
  quantity: z.number().int().positive().default(1),
  guest_token: z.string().optional(),
});

async function getOrCreateCart(userId?: number, guestToken?: string) {
  if (userId) {
    const existing = await pool.query('SELECT * FROM carts WHERE user_id = $1', [userId]);
    if (existing.rowCount) return existing.rows[0];
    const created = await pool.query('INSERT INTO carts (user_id) VALUES ($1) RETURNING *', [
      userId,
    ]);
    return created.rows[0];
  }

  const token = guestToken || crypto.randomUUID();
  const existing = await pool.query('SELECT * FROM carts WHERE guest_token = $1', [token]);
  if (existing.rowCount) return { ...existing.rows[0], guest_token: token };
  const created = await pool.query(
    `INSERT INTO carts (guest_token, expires_at)
     VALUES ($1, NOW() + INTERVAL '14 days') RETURNING *`,
    [token],
  );
  return created.rows[0];
}

async function cartSummary(cartId: number) {
  const lines = await pool.query(
    `SELECT cl.*, p.name, p.price, p.sale_price, p.sale_starts_at, p.sale_ends_at,
            p.stock, p.reserved_stock, p.status, p.is_active, p.track_inventory,
            pv.name AS variant_name, pv.price AS variant_price, pv.stock AS variant_stock,
            b.name AS build_name, b.subtotal AS build_subtotal,
            (SELECT pi.url FROM product_images pi
              WHERE pi.product_id = cl.product_id
              ORDER BY pi.position ASC, pi.id ASC
              LIMIT 1) AS image
     FROM cart_lines cl
     LEFT JOIN products p ON p.id = cl.product_id
     LEFT JOIN product_variants pv ON pv.id = cl.variant_id
     LEFT JOIN pc_builds b ON b.id = cl.build_id
     WHERE cl.cart_id = $1`,
    [cartId],
  );

  let subtotal = '0.00';
  const items = [];
  for (const line of lines.rows) {
    if (line.build_id) {
      const price = toMoney(line.build_subtotal);
      subtotal = addMoney(subtotal, mulMoney(price, line.quantity));
      items.push({
        ...line,
        name: line.build_name ? `تجميعة: ${line.build_name}` : 'تجميعة مخصصة',
        unit_price: price,
        line_total: mulMoney(price, line.quantity),
      });
    } else {
      const unit =
        line.variant_price != null ? toMoney(line.variant_price) : effectiveProductPrice(line);
      const lineTotal = mulMoney(unit, line.quantity);
      subtotal = addMoney(subtotal, lineTotal);
      items.push({ ...line, unit_price: unit, line_total: lineTotal });
    }
  }

  let discount = '0.00';
  let shipping = '0.00';
  const cart = await pool.query('SELECT * FROM carts WHERE id = $1', [cartId]);
  const couponCode = cart.rows[0]?.coupon_code;
  if (couponCode) {
    try {
      const { coupon, discount: d } = await validateCouponForAmount(
        couponCode,
        subtotal,
        cart.rows[0]?.user_id ?? null,
      );
      discount = d;
      if (coupon.type === 'free_shipping') shipping = '0.00';
    } catch {
      // Invalid/expired coupon left on cart — ignore discount until re-applied
      discount = '0.00';
    }
  }

  if (shipping === '0.00' && (!couponCode || discount === '0.00')) {
    const method = await pool.query(
      `SELECT * FROM shipping_methods WHERE is_active = TRUE ORDER BY base_rate ASC LIMIT 1`,
    );
    if (method.rowCount) {
      const m = method.rows[0];
      shipping =
        m.free_above && Number(subtotal) >= Number(m.free_above) ? '0.00' : toMoney(m.base_rate);
    }
  }

  const taxSetting = await pool.query(`SELECT value FROM store_settings WHERE key = 'tax_rate'`);
  const taxRate = Number(taxSetting.rows[0]?.value ?? 0);
  const taxable = Math.max(0, Number(subtotal) - Number(discount));
  const tax = toMoney((taxable * taxRate) / 100);
  const total = addMoney(toMoney(taxable), tax, shipping);

  return {
    cart: cart.rows[0],
    items,
    pricing: { subtotal, discount, tax, shipping, total, currency: config.STORE_CURRENCY },
  };
}

router.get(
  '/',
  optionalAuth(),
  asyncWrapper(async (req, res) => {
    const cart = await getOrCreateCart(
      req.user?.id,
      (req.query.guest_token as string) || undefined,
    );
    const summary = await cartSummary(cart.id);
    ok(res, { guest_token: cart.guest_token, ...summary });
  }),
);

router.post(
  '/items',
  optionalAuth(),
  validate(AddLine),
  asyncWrapper(async (req, res) => {
    const { product_id, variant_id, build_id, quantity, guest_token } = req.body;
    if (!product_id && !build_id) throw new HttpError(400, 'product_id or build_id required');

    const cart = await getOrCreateCart(req.user?.id, guest_token);

    if (build_id) {
      const build = await pool.query('SELECT * FROM pc_builds WHERE id = $1', [build_id]);
      if (!build.rowCount) throw new HttpError(404, 'Build not found');
      const items = await pool.query(
        `SELECT product_id, component_type, specs FROM pc_build_items bi
         JOIN products p ON p.id = bi.product_id WHERE bi.build_id = $1`,
        [build_id],
      );
      const compat = await checkBuildCompatibility(items.rows);
      if (compat.overall === 'incompatible') {
        throw new HttpError(400, 'Build has incompatible components');
      }
      const existingBuild = await pool.query(
        `SELECT id FROM cart_lines WHERE cart_id = $1 AND build_id = $2`,
        [cart.id, build_id],
      );
      if (existingBuild.rowCount) {
        await pool.query('UPDATE cart_lines SET quantity = $1, updated_at = NOW() WHERE id = $2', [
          quantity,
          existingBuild.rows[0].id,
        ]);
      } else {
        await pool.query(
          `INSERT INTO cart_lines (cart_id, build_id, quantity)
           VALUES ($1,$2,$3)`,
          [cart.id, build_id, quantity],
        );
      }
    } else {
      const product = await pool.query(
        `SELECT * FROM products WHERE id = $1 AND status = 'active' AND is_active = TRUE`,
        [product_id],
      );
      if (!product.rowCount) throw new HttpError(400, 'Product not available');
      const available = Number(product.rows[0].stock) - Number(product.rows[0].reserved_stock || 0);
      if (product.rows[0].track_inventory && available < quantity) {
        throw new HttpError(400, 'Insufficient stock');
      }
      const existing = await pool.query(
        `SELECT id FROM cart_lines WHERE cart_id = $1 AND product_id = $2
         AND COALESCE(variant_id,0) = COALESCE($3,0) AND build_id IS NULL`,
        [cart.id, product_id, variant_id ?? null],
      );
      if (existing.rowCount) {
        await pool.query('UPDATE cart_lines SET quantity = $1, updated_at = NOW() WHERE id = $2', [
          quantity,
          existing.rows[0].id,
        ]);
      } else {
        await pool.query(
          `INSERT INTO cart_lines (cart_id, product_id, variant_id, quantity)
           VALUES ($1,$2,$3,$4)`,
          [cart.id, product_id, variant_id ?? null, quantity],
        );
      }
    }

    const summary = await cartSummary(cart.id);
    ok(res, { guest_token: cart.guest_token, ...summary });
  }),
);

router.patch(
  '/items/:id',
  optionalAuth(),
  validate(z.object({ quantity: z.number().int().positive(), guest_token: z.string().optional() })),
  asyncWrapper(async (req, res) => {
    const cart = await getOrCreateCart(req.user?.id, req.body.guest_token);
    const result = await pool.query(
      'UPDATE cart_lines SET quantity = $1, updated_at = NOW() WHERE id = $2 AND cart_id = $3 RETURNING *',
      [req.body.quantity, req.params.id, cart.id],
    );
    if (!result.rowCount) throw new HttpError(404, 'Cart item not found');
    ok(res, await cartSummary(cart.id));
  }),
);

router.delete(
  '/items/:id',
  optionalAuth(),
  asyncWrapper(async (req, res) => {
    const cart = await getOrCreateCart(req.user?.id, req.query.guest_token as string | undefined);
    await pool.query('DELETE FROM cart_lines WHERE id = $1 AND cart_id = $2', [
      req.params.id,
      cart.id,
    ]);
    ok(res, await cartSummary(cart.id));
  }),
);

router.post(
  '/coupon',
  optionalAuth(),
  validate(z.object({ code: z.string().min(1), guest_token: z.string().optional() })),
  asyncWrapper(async (req, res) => {
    const cart = await getOrCreateCart(req.user?.id, req.body.guest_token);
    const summary = await cartSummary(cart.id);
    const { coupon } = await validateCouponForAmount(
      req.body.code,
      summary.pricing.subtotal,
      req.user?.id ?? cart.user_id ?? null,
    );
    await pool.query('UPDATE carts SET coupon_code = $1, updated_at = NOW() WHERE id = $2', [
      coupon.code,
      cart.id,
    ]);
    ok(res, await cartSummary(cart.id));
  }),
);

router.delete(
  '/coupon',
  optionalAuth(),
  asyncWrapper(async (req, res) => {
    const cart = await getOrCreateCart(req.user?.id, req.query.guest_token as string | undefined);
    await pool.query('UPDATE carts SET coupon_code = NULL WHERE id = $1', [cart.id]);
    ok(res, await cartSummary(cart.id));
  }),
);

router.post(
  '/merge',
  authMiddleware(),
  validate(z.object({ guest_token: z.string().min(1) })),
  asyncWrapper(async (req, res) => {
    await withTransaction(async (client) => {
      const guest = await client.query('SELECT * FROM carts WHERE guest_token = $1', [
        req.body.guest_token,
      ]);
      if (!guest.rowCount) return;
      let userCart = await client.query('SELECT * FROM carts WHERE user_id = $1', [req.user!.id]);
      if (!userCart.rowCount) {
        userCart = await client.query('INSERT INTO carts (user_id) VALUES ($1) RETURNING *', [
          req.user!.id,
        ]);
      }
      await client.query(`UPDATE cart_lines SET cart_id = $1 WHERE cart_id = $2`, [
        userCart.rows[0].id,
        guest.rows[0].id,
      ]);
      await client.query('DELETE FROM carts WHERE id = $1', [guest.rows[0].id]);
    });
    const cart = await getOrCreateCart(req.user!.id);
    ok(res, await cartSummary(cart.id));
  }),
);

export { getOrCreateCart, cartSummary };
