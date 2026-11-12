import { Router } from 'express';
import { z } from 'zod';
import pool from '../../db/pool';
import { asyncWrapper, config, HttpError, publicApiBase } from '../../utils';
import { authMiddleware, optionalAuth, requirePermission } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { created, ok, paginated } from '../../shared/response';
import { getOffset, PaginationQuery } from '../../shared/pagination';
import { addMoney, effectiveProductPrice, mulMoney, toMoney } from '../../shared/money';
import { withTransaction } from '../../shared/db';
import { writeAudit } from '../../services/audit';
import { cartSummary, getOrCreateCart } from '../cart/routes';
import { checkBuildCompatibility } from '../compatibility/engine';
import { validateCouponForAmount } from '../../services/coupons';
import { createPaymobCheckout, paymobConfigured } from '../../services/paymob';
import {
  createTamaraCheckout,
  maybeCaptureTamaraOnShip,
  tamaraAmountAllowed,
  tamaraConfigured,
} from '../../services/tamara';
import { maybeNotifyOrderWhatsApp } from '../../services/whatsapp';
import { onOrderCancelled, PaymentSideEffectResult } from '../../services/paymentSideEffects';

export const router = Router();

const ShippingAddress = z.object({
  full_name: z.string().min(1),
  phone: z.string().min(8),
  governorate: z.string().optional(),
  city: z.string().optional(),
  address_line1: z.string().min(1),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
});

const CheckoutBody = z.object({
  guest_token: z.string().optional(),
  guest_email: z.string().email().optional(),
  phone: z.string().min(8),
  shipping_address: ShippingAddress,
  billing_address: z.record(z.any()).optional(),
  shipping_method_code: z.string().optional(),
  payment_method: z
    .enum(['cod', 'cash_on_delivery', 'bank_transfer', 'card', 'paymob', 'tamara'])
    .default('cod'),
  customer_notes: z.string().optional(),
});

/** Buy one product without using the cart */
const BuyNowBody = CheckoutBody.extend({
  product_id: z.number().int().positive(),
  variant_id: z.number().int().positive().optional().nullable(),
  quantity: z.number().int().positive().default(1),
  coupon_code: z.string().min(1).optional(),
});

const TrackQuery = z.object({
  order_number: z.string().min(3),
  phone: z.string().min(8),
});

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending: ['awaiting_confirmation', 'confirmed', 'cancelled', 'pending_payment'],
  pending_payment: ['awaiting_confirmation', 'confirmed', 'cancelled'],
  awaiting_confirmation: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['ready_for_shipment', 'cancelled'],
  ready_for_shipment: ['shipped', 'cancelled'],
  shipped: ['delivered', 'return_requested'],
  delivered: ['return_requested', 'returned'],
  return_requested: ['returned', 'delivered'],
  returned: ['refunded', 'partially_refunded'],
  cancelled: [],
  refunded: [],
  partially_refunded: ['refunded'],
};

const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'paid',
  'failed',
  'refunded',
  'partially_refunded',
] as const;

const FULFILLMENT_STATUSES = [
  'unfulfilled',
  'partial',
  'ready_for_shipment',
  'shipped',
  'delivered',
  'cancelled',
] as const;

/** Sync payment/fulfillment columns when order status changes */
function statusSideEffects(status: string): {
  payment_status?: string;
  fulfillment_status?: string;
} {
  switch (status) {
    case 'ready_for_shipment':
      return { fulfillment_status: 'ready_for_shipment' };
    case 'shipped':
      return { fulfillment_status: 'shipped' };
    case 'delivered':
      return { fulfillment_status: 'delivered', payment_status: 'paid' };
    case 'cancelled':
      return { fulfillment_status: 'cancelled' };
    case 'refunded':
      return { payment_status: 'refunded' };
    case 'partially_refunded':
      return { payment_status: 'partially_refunded' };
    default:
      return {};
  }
}

function isPaymob(method?: string) {
  return method === 'card' || method === 'paymob';
}

function isTamara(method?: string) {
  return method === 'tamara';
}

function isOnlinePayment(method?: string) {
  return isPaymob(method) || isTamara(method);
}

function paymentMethodLabel(method?: string) {
  if (isTamara(method)) return 'tamara';
  if (isPaymob(method)) return 'paymob';
  if (method === 'bank_transfer') return 'bank_transfer';
  return 'cash_on_delivery';
}

function frontendBase(origin?: string | null) {
  const allowed = config.CORS_ORIGIN.split(',').map((item) => item.trim());
  if (origin && allowed.includes(origin)) return origin;
  return config.FRONTEND_HOST.split(',')[0].trim();
}

async function respondOrder(
  req: {
    protocol: string;
    get(name: string): string | undefined;
    user?: { email?: string | null };
  },
  res: Parameters<typeof created>[0],
  order: {
    id: number;
    order_number: string;
    total: string | number;
    shipping_total?: string | number | null;
    tax_total?: string | number | null;
    discount_total?: string | number | null;
    phone?: string | null;
    guest_email?: string | null;
    shipping_address?: string | null;
    shipping_address_json?: Record<string, unknown> | null;
  },
  body: {
    payment_method?: string;
    phone: string;
    guest_email?: string;
    shipping_address: { full_name: string; city?: string; address_line1: string };
  },
) {
  const paymentMethod = paymentMethodLabel(body.payment_method);
  if (!isOnlinePayment(body.payment_method)) {
    created(res, {
      ...order,
      paymentMethod,
      checkoutUrl: null,
      checkout_url: null,
      clientSecret: null,
      paymentToken: null,
      paymentError: null,
    });
    return;
  }

  const billing = {
    full_name: body.shipping_address.full_name,
    phone: body.phone,
    email: body.guest_email || req.user?.email || null,
    city: body.shipping_address.city,
    address_line1: body.shipping_address.address_line1,
  };
  const common = {
    order,
    billing,
    frontendReturn: frontendBase(req.get('origin')),
    apiPublicBase: publicApiBase(req),
  };

  try {
    if (isTamara(body.payment_method)) {
      const session = await createTamaraCheckout(common);
      created(res, {
        ...order,
        paymentMethod: 'tamara',
        payment_provider: 'tamara',
        checkoutUrl: session.checkoutUrl,
        checkout_url: session.checkoutUrl,
        clientSecret: session.clientSecret,
        paymentToken: session.paymentToken,
        paymentError: null,
      });
      return;
    }

    const session = await createPaymobCheckout(common);
    created(res, {
      ...order,
      paymentMethod: 'paymob',
      payment_provider: 'paymob',
      checkoutUrl: session.checkoutUrl,
      checkout_url: session.checkoutUrl,
      clientSecret: session.clientSecret,
      paymentToken: session.paymentToken,
      paymentError: null,
    });
  } catch (err) {
    const message = err instanceof HttpError ? err.message : 'تعذر بدء الدفع الإلكتروني';
    created(res, {
      ...order,
      paymentMethod,
      payment_provider: paymentMethod,
      checkoutUrl: null,
      checkout_url: null,
      clientSecret: null,
      paymentToken: null,
      paymentError: message,
      payment_error: message,
    });
  }
}

function orderNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(Math.random() * 900000 + 100000);
  return `ARK-${stamp}-${rand}`;
}

router.post(
  '/checkout',
  optionalAuth(),
  validate(CheckoutBody),
  asyncWrapper(async (req, res) => {
    const body = req.body;
    if (isPaymob(body.payment_method) && !config.PAYMOB_INTEGRATION_ID.trim()) {
      throw new HttpError(
        500,
        'إعدادات Paymob غير مكتملة. يرجى التحقق من PAYMOB_SECRET_KEY و PAYMOB_INTEGRATION_ID في ملف .env',
      );
    }
    if (isTamara(body.payment_method) && !tamaraConfigured()) {
      throw new HttpError(400, 'الدفع عبر تمارا غير متاح حالياً. اختر طريقة دفع أخرى.');
    }
    if (isPaymob(body.payment_method) && !paymobConfigured()) {
      throw new HttpError(400, 'الدفع بالبطاقة غير متاح حالياً. اختر طريقة دفع أخرى.');
    }
    // Guest checkout allowed with phone + shipping_address (email optional)

    const cart = await getOrCreateCart(req.user?.id, body.guest_token);
    const summary = await cartSummary(cart.id);
    if (!summary.items.length) throw new HttpError(400, 'Cart is empty');

    const order = await withTransaction(async (client) => {
      // Revalidate stock + prices from DB
      for (const item of summary.items) {
        if (item.build_id) {
          const buildItems = await client.query(
            `SELECT bi.*, p.status, p.is_active, p.stock, p.reserved_stock, p.track_inventory,
                    p.component_type, p.specs, p.price, p.sale_price, p.sale_starts_at, p.sale_ends_at
             FROM pc_build_items bi
             JOIN products p ON p.id = bi.product_id
             WHERE bi.build_id = $1 FOR UPDATE OF p`,
            [item.build_id],
          );
          const compat = await checkBuildCompatibility(buildItems.rows);
          if (compat.overall === 'incompatible') {
            throw new HttpError(400, 'Build contains incompatible components');
          }
          for (const bi of buildItems.rows) {
            if (bi.status !== 'active' || !bi.is_active) {
              throw new HttpError(400, `Component unavailable: product ${bi.product_id}`);
            }
            if (bi.track_inventory) {
              const available = Number(bi.stock) - Number(bi.reserved_stock || 0);
              if (available < bi.quantity * item.quantity) {
                throw new HttpError(400, `Insufficient stock for product ${bi.product_id}`);
              }
            }
          }
        } else {
          const p = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [
            item.product_id,
          ]);
          if (!p.rowCount || p.rows[0].status !== 'active' || !p.rows[0].is_active) {
            throw new HttpError(400, `Product unavailable: ${item.product_id}`);
          }
          if (p.rows[0].track_inventory) {
            const available = Number(p.rows[0].stock) - Number(p.rows[0].reserved_stock || 0);
            if (available < item.quantity) {
              throw new HttpError(400, `Insufficient stock for product ${item.product_id}`);
            }
          }
          const serverPrice = effectiveProductPrice(p.rows[0]);
          if (toMoney(item.unit_price) !== serverPrice) {
            // Recalculate — never trust client; continue with server price
            item.unit_price = serverPrice;
            item.line_total = mulMoney(serverPrice, item.quantity);
          }
        }
      }

      // Recalc totals server-side from validated lines
      let subtotal = '0.00';
      for (const item of summary.items) {
        subtotal = addMoney(subtotal, item.line_total);
      }
      const pricing = {
        ...summary.pricing,
        subtotal,
        total: addMoney(
          toMoney(Math.max(0, Number(subtotal) - Number(summary.pricing.discount))),
          summary.pricing.tax,
          summary.pricing.shipping,
        ),
      };

      if (isTamara(body.payment_method) && !tamaraAmountAllowed(Number(pricing.total))) {
        throw new HttpError(400, 'قيمة الطلب خارج الحدود المسموحة للدفع عبر تمارا.');
      }
      const onum = orderNumber();
      // glassShop-style: start Pending; move to awaiting_confirmation only after WA send succeeds
      const initialStatus = isOnlinePayment(body.payment_method) ? 'pending_payment' : 'pending';
      const createdOrder = await client.query(
        `INSERT INTO orders (
          user_id, order_number, status, payment_status, fulfillment_status,
          subtotal, discount_total, tax_total, shipping_total, total, currency,
          phone, shipping_address, shipping_address_json, billing_address,
          customer_notes, coupon_code, guest_email
        ) VALUES (
          $1,$2,$3,$4,'unfulfilled',
          $5,$6,$7,$8,$9,'${config.STORE_CURRENCY}',
          $10,$11,$12,$13,$14,$15,$16
        ) RETURNING *`,
        [
          req.user?.id ?? null,
          onum,
          initialStatus,
          'pending',
          pricing.subtotal,
          pricing.discount,
          pricing.tax,
          pricing.shipping,
          pricing.total,
          body.phone,
          body.shipping_address.address_line1,
          JSON.stringify(body.shipping_address),
          JSON.stringify(body.billing_address ?? body.shipping_address),
          body.customer_notes ?? null,
          cart.coupon_code ?? null,
          body.guest_email ?? null,
        ],
      );
      const orderRow = createdOrder.rows[0];

      for (const item of summary.items) {
        if (item.build_id) {
          const buildItems = await client.query(
            `SELECT bi.*, p.name, p.sku, p.specs, p.component_type
             FROM pc_build_items bi JOIN products p ON p.id = bi.product_id
             WHERE bi.build_id = $1`,
            [item.build_id],
          );
          const snapshot = buildItems.rows.map((bi) => ({
            product_id: bi.product_id,
            name: bi.name,
            sku: bi.sku,
            quantity: bi.quantity,
            unit_price: bi.unit_price,
            specs: bi.specs,
            component_type: bi.component_type,
          }));

          await client.query(
            `INSERT INTO order_items
             (order_id, product_id, product_name, quantity, price, build_id, build_snapshot, line_total, sku)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, NULL)`,
            [
              orderRow.id,
              item.build_name || 'Custom PC Build',
              item.quantity,
              item.unit_price,
              item.build_id,
              JSON.stringify(snapshot),
              item.line_total,
            ],
          );

          for (const bi of buildItems.rows) {
            await client.query(
              `UPDATE products SET stock = stock - $1, updated_at = NOW()
               WHERE id = $2 AND track_inventory = TRUE`,
              [bi.quantity * item.quantity, bi.product_id],
            );
            await client.query(
              `INSERT INTO stock_movements
               (product_id, movement_type, quantity, reason, reference_type, reference_id, actor_id)
               VALUES ($1,'sale',$2,'Order checkout','order',$3,$4)`,
              [bi.product_id, -(bi.quantity * item.quantity), orderRow.id, req.user?.id ?? null],
            );
          }
        } else {
          await client.query(
            `INSERT INTO order_items
             (order_id, product_id, variant_id, product_name, quantity, price, sku, specs_snapshot, line_total)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              orderRow.id,
              item.product_id,
              item.variant_id ?? null,
              item.name,
              item.quantity,
              item.unit_price,
              null,
              null,
              item.line_total,
            ],
          );
          await client.query(
            `UPDATE products SET stock = stock - $1, updated_at = NOW()
             WHERE id = $2 AND track_inventory = TRUE`,
            [item.quantity, item.product_id],
          );
          await client.query(
            `INSERT INTO stock_movements
             (product_id, variant_id, movement_type, quantity, reason, reference_type, reference_id, actor_id)
             VALUES ($1,$2,'sale',$3,'Order checkout','order',$4,$5)`,
            [
              item.product_id,
              item.variant_id ?? null,
              -item.quantity,
              orderRow.id,
              req.user?.id ?? null,
            ],
          );
        }
      }

      await client.query(
        `INSERT INTO payments (order_id, provider, method, amount, currency, status, idempotency_key)
         VALUES ($1,$2,$3,$4,'${config.STORE_CURRENCY}','pending',$5)`,
        [
          orderRow.id,
          paymentMethodLabel(body.payment_method),
          paymentMethodLabel(body.payment_method),
          pricing.total,
          `pay-${orderRow.id}-${Date.now()}`,
        ],
      );

      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, note, actor_id)
         VALUES ($1,NULL,$2,$3,$4)`,
        [
          orderRow.id,
          orderRow.status,
          orderRow.status === 'pending_payment'
            ? isTamara(body.payment_method)
              ? 'Awaiting Tamara payment'
              : 'Awaiting card payment'
            : 'Order placed',
          req.user?.id ?? null,
        ],
      );

      await client.query('DELETE FROM cart_lines WHERE cart_id = $1', [cart.id]);
      await client.query('UPDATE carts SET coupon_code = NULL WHERE id = $1', [cart.id]);

      if (cart.coupon_code) {
        const coupon = await client.query('SELECT id FROM coupons WHERE code = $1', [
          cart.coupon_code,
        ]);
        if (coupon.rowCount) {
          await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [
            coupon.rows[0].id,
          ]);
          await client.query(
            `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id) VALUES ($1,$2,$3)`,
            [coupon.rows[0].id, req.user?.id ?? null, orderRow.id],
          );
        }
      }

      return orderRow;
    });

    await writeAudit({
      actorId: req.user?.id,
      action: 'order.create',
      resourceType: 'order',
      resourceId: order.id,
      after: order,
    });

    // glassShop: await WA send; only then status becomes awaiting_confirmation
    let finalOrder = order;
    if (!isOnlinePayment(body.payment_method)) {
      await maybeNotifyOrderWhatsApp(order.id);
      const refreshed = await pool.query('SELECT * FROM orders WHERE id = $1', [order.id]);
      if (refreshed.rowCount) finalOrder = refreshed.rows[0];
    }

    await respondOrder(req, res, finalOrder, body);
  }),
);

router.get(
  '/me',
  authMiddleware(),
  asyncWrapper(async (req, res) => {
    const query = PaginationQuery.parse(req.query);
    const count = await pool.query('SELECT COUNT(*)::int AS total FROM orders WHERE user_id = $1', [
      req.user!.id,
    ]);
    const result = await pool.query(
      `SELECT * FROM orders WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user!.id, query.limit, getOffset(query.page, query.limit)],
    );
    paginated(res, result.rows, {
      total: count.rows[0].total,
      page: query.page,
      limit: query.limit,
    });
  }),
);

router.get(
  '/me/:id',
  authMiddleware(),
  asyncWrapper(async (req, res) => {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user!.id,
    ]);
    if (!order.rowCount) throw new HttpError(404, 'Order not found');
    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [
      req.params.id,
    ]);
    const history = await pool.query(
      'SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY created_at',
      [req.params.id],
    );
    ok(res, { ...order.rows[0], items: items.rows, history: history.rows });
  }),
);

/** Guest/public tracking by order_number + phone */
router.get(
  '/track',
  asyncWrapper(async (req, res) => {
    const query = TrackQuery.parse(req.query);
    const order = await pool.query(
      `SELECT id, order_number, status, payment_status, fulfillment_status,
              subtotal, discount_total, tax_total, shipping_total, total, currency,
              phone, shipping_address, shipping_address_json, customer_notes,
              created_at, updated_at
       FROM orders
       WHERE order_number = $1 AND phone = $2`,
      [query.order_number.trim(), query.phone.trim()],
    );
    if (!order.rowCount) throw new HttpError(404, 'Order not found');
    const items = await pool.query(
      `SELECT id, product_id, variant_id, product_name, quantity, price, line_total, sku
       FROM order_items WHERE order_id = $1`,
      [order.rows[0].id],
    );
    const history = await pool.query(
      `SELECT from_status, to_status, note, created_at
       FROM order_status_history WHERE order_id = $1 ORDER BY created_at`,
      [order.rows[0].id],
    );
    ok(res, { ...order.rows[0], items: items.rows, history: history.rows });
  }),
);

/** Buy a single product immediately (guest or logged-in) — does not clear cart */
router.post(
  '/buy-now',
  optionalAuth(),
  validate(BuyNowBody),
  asyncWrapper(async (req, res) => {
    const body = req.body as z.infer<typeof BuyNowBody>;
    if (isPaymob(body.payment_method) && !config.PAYMOB_INTEGRATION_ID.trim()) {
      throw new HttpError(
        500,
        'إعدادات Paymob غير مكتملة. يرجى التحقق من PAYMOB_SECRET_KEY و PAYMOB_INTEGRATION_ID في ملف .env',
      );
    }
    if (isTamara(body.payment_method) && !tamaraConfigured()) {
      throw new HttpError(400, 'الدفع عبر تمارا غير متاح حالياً. اختر طريقة دفع أخرى.');
    }
    if (isPaymob(body.payment_method) && !paymobConfigured()) {
      throw new HttpError(400, 'الدفع بالبطاقة غير متاح حالياً. اختر طريقة دفع أخرى.');
    }
    const qty = body.quantity || 1;

    const order = await withTransaction(async (client) => {
      const pRes = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [
        body.product_id,
      ]);
      if (!pRes.rowCount || pRes.rows[0].status !== 'active' || !pRes.rows[0].is_active) {
        throw new HttpError(400, `Product unavailable: ${body.product_id}`);
      }
      const product = pRes.rows[0];

      let unitPrice = effectiveProductPrice(product);
      let productName = product.name;
      let sku = product.sku ?? null;
      const variantId: number | null = body.variant_id ?? null;

      if (variantId) {
        const vRes = await client.query(
          `SELECT * FROM product_variants WHERE id = $1 AND product_id = $2 FOR UPDATE`,
          [variantId, body.product_id],
        );
        if (!vRes.rowCount || vRes.rows[0].is_active === false) {
          throw new HttpError(400, `Variant unavailable: ${variantId}`);
        }
        const variant = vRes.rows[0];
        if (variant.price != null) unitPrice = toMoney(variant.price);
        productName = variant.name ? `${product.name} — ${variant.name}` : product.name;
        sku = variant.sku ?? sku;
        const vAvailable = Number(variant.stock) - Number(variant.reserved_stock || 0);
        if (vAvailable < qty) {
          throw new HttpError(400, `Insufficient stock for variant ${variantId}`);
        }
      } else if (product.track_inventory) {
        const available = Number(product.stock) - Number(product.reserved_stock || 0);
        if (available < qty) {
          throw new HttpError(400, `Insufficient stock for product ${body.product_id}`);
        }
      }

      const lineTotal = mulMoney(unitPrice, qty);
      const subtotal = lineTotal;
      let discount = '0.00';
      let appliedCouponCode: string | null = null;
      if (body.coupon_code) {
        const { coupon, discount: d } = await validateCouponForAmount(
          body.coupon_code,
          subtotal,
          req.user?.id ?? null,
        );
        discount = d;
        appliedCouponCode = coupon.code;
      }
      const tax = '0.00';
      const shipping = '0.00';
      const taxable = Math.max(0, Number(subtotal) - Number(discount));
      const total = addMoney(toMoney(taxable), tax, shipping);

      if (isTamara(body.payment_method) && !tamaraAmountAllowed(Number(total))) {
        throw new HttpError(400, 'قيمة الطلب خارج الحدود المسموحة للدفع عبر تمارا.');
      }
      const onum = orderNumber();
      const initialStatus = isOnlinePayment(body.payment_method) ? 'pending_payment' : 'pending';
      const createdOrder = await client.query(
        `INSERT INTO orders (
          user_id, order_number, status, payment_status, fulfillment_status,
          subtotal, discount_total, tax_total, shipping_total, total, currency,
          phone, shipping_address, shipping_address_json, billing_address,
          customer_notes, coupon_code, guest_email
        ) VALUES (
          $1,$2,$3,$4,'unfulfilled',
          $5,$6,$7,$8,$9,'${config.STORE_CURRENCY}',
          $10,$11,$12,$13,$14,$15,$16
        ) RETURNING *`,
        [
          req.user?.id ?? null,
          onum,
          initialStatus,
          'pending',
          subtotal,
          discount,
          tax,
          shipping,
          total,
          body.phone,
          body.shipping_address.address_line1,
          JSON.stringify(body.shipping_address),
          JSON.stringify(body.billing_address ?? body.shipping_address),
          body.customer_notes ?? null,
          appliedCouponCode,
          body.guest_email ?? null,
        ],
      );
      const orderRow = createdOrder.rows[0];

      if (appliedCouponCode) {
        const c = await client.query('SELECT id FROM coupons WHERE code = $1', [appliedCouponCode]);
        if (c.rowCount) {
          await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [
            c.rows[0].id,
          ]);
          await client.query(
            `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id) VALUES ($1,$2,$3)`,
            [c.rows[0].id, req.user?.id ?? null, orderRow.id],
          );
        }
      }

      await client.query(
        `INSERT INTO order_items
         (order_id, product_id, variant_id, product_name, quantity, price, sku, specs_snapshot, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          orderRow.id,
          body.product_id,
          variantId,
          productName,
          qty,
          unitPrice,
          sku,
          null,
          lineTotal,
        ],
      );

      if (variantId) {
        await client.query(
          `UPDATE product_variants SET stock = stock - $1, updated_at = NOW() WHERE id = $2`,
          [qty, variantId],
        );
      }
      await client.query(
        `UPDATE products SET stock = stock - $1, updated_at = NOW()
         WHERE id = $2 AND track_inventory = TRUE`,
        [qty, body.product_id],
      );
      await client.query(
        `INSERT INTO stock_movements
         (product_id, variant_id, movement_type, quantity, reason, reference_type, reference_id, actor_id)
         VALUES ($1,$2,'sale',$3,'Buy now','order',$4,$5)`,
        [body.product_id, variantId, -qty, orderRow.id, req.user?.id ?? null],
      );

      await client.query(
        `INSERT INTO payments (order_id, provider, method, amount, currency, status, idempotency_key)
         VALUES ($1,$2,$3,$4,'${config.STORE_CURRENCY}','pending',$5)`,
        [
          orderRow.id,
          paymentMethodLabel(body.payment_method),
          paymentMethodLabel(body.payment_method),
          total,
          `pay-${orderRow.id}-${Date.now()}`,
        ],
      );

      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, note, actor_id)
         VALUES ($1,NULL,$2,$3,$4)`,
        [
          orderRow.id,
          orderRow.status,
          orderRow.status === 'pending_payment'
            ? isTamara(body.payment_method)
              ? 'Awaiting Tamara payment'
              : 'Awaiting card payment'
            : 'Buy now order placed',
          req.user?.id ?? null,
        ],
      );

      return orderRow;
    });

    await writeAudit({
      actorId: req.user?.id,
      action: 'order.buy_now',
      resourceType: 'order',
      resourceId: order.id,
      after: order,
    });

    let finalOrder = order;
    if (!isOnlinePayment(body.payment_method)) {
      await maybeNotifyOrderWhatsApp(order.id);
      const refreshed = await pool.query('SELECT * FROM orders WHERE id = $1', [order.id]);
      if (refreshed.rowCount) finalOrder = refreshed.rows[0];
    }

    await respondOrder(req, res, finalOrder, body);
  }),
);

router.get(
  '/',
  authMiddleware(['admin']),
  requirePermission('orders.read'),
  asyncWrapper(async (req, res) => {
    const query = PaginationQuery.extend({
      status: z.string().optional(),
      payment_status: z.string().optional(),
      fulfillment_status: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    }).parse(req.query);

    const values: unknown[] = [];
    const where: string[] = [];
    let i = 1;
    if (query.status) {
      where.push(`o.status = $${i++}`);
      values.push(query.status);
    }
    if (query.payment_status) {
      where.push(`o.payment_status = $${i++}`);
      values.push(query.payment_status);
    }
    if (query.fulfillment_status) {
      where.push(`o.fulfillment_status = $${i++}`);
      values.push(query.fulfillment_status);
    }
    if (query.from) {
      where.push(`o.created_at >= $${i++}`);
      values.push(query.from);
    }
    if (query.to) {
      where.push(`o.created_at <= $${i++}`);
      values.push(query.to);
    }
    if (query.q) {
      where.push(
        `(o.order_number ILIKE $${i} OR o.phone ILIKE $${i} OR o.guest_email ILIKE $${i} OR u.name ILIKE $${i} OR u.email ILIKE $${i} OR o.shipping_address_json->>'full_name' ILIKE $${i})`,
      );
      values.push(`%${query.q}%`);
      i++;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ${whereSql}`,
      values,
    );
    values.push(query.limit, getOffset(query.page, query.limit));
    const result = await pool.query(
      `SELECT o.*,
              u.name AS customer_name,
              u.email AS customer_email,
              (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS items_count,
              COALESCE(o.shipping_address_json->>'full_name', u.name) AS shipping_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ${whereSql}
       ORDER BY o.created_at DESC
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

router.get(
  '/:id',
  authMiddleware(['admin']),
  requirePermission('orders.read'),
  asyncWrapper(async (req, res) => {
    const order = await pool.query(
      `SELECT o.*,
              u.name AS customer_name,
              u.email AS customer_email,
              u.phone AS customer_phone
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       WHERE o.id = $1`,
      [req.params.id],
    );
    if (!order.rowCount) throw new HttpError(404, 'Order not found');
    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [
      req.params.id,
    ]);
    const history = await pool.query(
      `SELECT h.*, a.name AS actor_name
       FROM order_status_history h
       LEFT JOIN users a ON a.id = h.actor_id
       WHERE h.order_id = $1
       ORDER BY h.created_at`,
      [req.params.id],
    );
    const payments = await pool.query('SELECT * FROM payments WHERE order_id = $1', [
      req.params.id,
    ]);
    const row = order.rows[0];
    ok(res, {
      ...row,
      items: items.rows,
      history: history.rows,
      payments: payments.rows,
      allowed_next_statuses: ALLOWED_TRANSITIONS[row.status] || [],
    });
  }),
);

/** Admin: update notes / payment / fulfillment without changing order status */
router.patch(
  '/:id',
  authMiddleware(['admin']),
  requirePermission('orders.manage'),
  validate(
    z
      .object({
        admin_notes: z.string().optional().nullable(),
        payment_status: z.enum(PAYMENT_STATUSES).optional(),
        fulfillment_status: z.enum(FULFILLMENT_STATUSES).optional(),
        phone: z.string().min(8).optional(),
        customer_notes: z.string().optional().nullable(),
      })
      .refine((b) => Object.keys(b).length > 0, { message: 'No fields' }),
  ),
  asyncWrapper(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!existing.rowCount) throw new HttpError(404, 'Order not found');

    const body = req.body as Record<string, unknown>;
    const allowed = [
      'admin_notes',
      'payment_status',
      'fulfillment_status',
      'phone',
      'customer_notes',
    ] as const;
    const keys = allowed.filter((k) => body[k] !== undefined);
    const updates = keys.map((k, idx) => `${k} = $${idx + 1}`);
    updates.push('updated_at = NOW()');
    const values = keys.map((k) => body[k]);
    values.push(id);

    const result = await pool.query(
      `UPDATE orders SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );

    await writeAudit({
      actorId: req.user!.id,
      action: 'order.update',
      resourceType: 'order',
      resourceId: id,
      before: existing.rows[0],
      after: result.rows[0],
    });

    ok(res, {
      ...result.rows[0],
      allowed_next_statuses: ALLOWED_TRANSITIONS[result.rows[0].status] || [],
    });
  }),
);

router.patch(
  '/:id/status',
  authMiddleware(['admin']),
  requirePermission('orders.manage'),
  validate(
    z.object({
      status: z.string(),
      note: z.string().optional(),
    }),
  ),
  asyncWrapper(async (req, res) => {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!orderRes.rowCount) throw new HttpError(404, 'Order not found');
    const order = orderRes.rows[0];
    const nextStatus = req.body.status as string;
    const allowed = ALLOWED_TRANSITIONS[order.status] || [];
    if (!allowed.includes(nextStatus)) {
      throw new HttpError(400, `لا يمكن تغيير الحالة من ${order.status} إلى ${nextStatus}`);
    }

    const side = statusSideEffects(nextStatus);

    const updated = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE orders SET
           status = $1,
           payment_status = COALESCE($2, payment_status),
           fulfillment_status = COALESCE($3, fulfillment_status),
           cancelled_reason = CASE WHEN $1 = 'cancelled' THEN COALESCE($4, cancelled_reason) ELSE cancelled_reason END,
           updated_at = NOW()
         WHERE id = $5 RETURNING *`,
        [
          nextStatus,
          side.payment_status ?? null,
          side.fulfillment_status ?? null,
          nextStatus === 'cancelled' ? (req.body.note ?? 'Cancelled') : null,
          order.id,
        ],
      );
      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, note, actor_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.id, order.status, nextStatus, req.body.note ?? null, req.user!.id],
      );

      // Restock only after return inspection workflow — cancel does NOT auto-restock sellable stock
      return result.rows[0];
    });

    await writeAudit({
      actorId: req.user!.id,
      action: 'order.status_change',
      resourceType: 'order',
      resourceId: order.id,
      before: { status: order.status },
      after: { status: updated.status },
    });

    let paymentResult: PaymentSideEffectResult | null = null;
    if (nextStatus === 'shipped') {
      const capture = await maybeCaptureTamaraOnShip(order.id, req.body.note ?? null).catch(
        (err) => ({ attempted: true, ok: false, error: String(err?.message || err) }),
      );
      if (!capture.ok) {
        await pool.query(
          `INSERT INTO order_status_history (order_id, from_status, to_status, note)
           VALUES ($1, $2, $2, $3)`,
          [order.id, nextStatus, capture.error || 'Tamara capture failed'],
        );
        paymentResult = {
          ok: false,
          warning: `فشل تأكيد الشحن (Capture) في تمارا: ${capture.error || ''}`.trim(),
        };
      }
    } else if (nextStatus === 'cancelled') {
      paymentResult = await onOrderCancelled(order.id, req.body.note || 'Cancelled by store');
    }

    const fresh = await pool.query('SELECT * FROM orders WHERE id = $1', [order.id]);
    const current = fresh.rows[0] ?? updated;
    ok(res, {
      ...current,
      allowed_next_statuses: ALLOWED_TRANSITIONS[current.status] || [],
      payment_action: paymentResult?.action ?? null,
      payment_warning: paymentResult?.warning ?? null,
    });
  }),
);
