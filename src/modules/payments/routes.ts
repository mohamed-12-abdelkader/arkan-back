import { Router } from 'express';
import { z } from 'zod';
import pool from '../../db/pool';
import { asyncWrapper, HttpError, config, publicApiBase } from '../../utils';
import { optionalAuth } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { created, ok } from '../../shared/response';
import {
  applyPaymobResult,
  createPaymobCheckout,
  findOrderByPaymobReference,
  paymobConfigured,
  verifyPaymobHmac,
} from '../../services/paymob';
import {
  applyTamaraWebhook,
  checkTamaraEligibility,
  createTamaraCheckout,
  syncTamaraReturn,
  tamaraAmountAllowed,
  tamaraConfigured,
  verifyTamaraWebhookToken,
} from '../../services/tamara';

export const router = Router();

function frontendBase(reqOrigin?: string | null) {
  const allowed = config.CORS_ORIGIN.split(',').map((o) => o.trim());
  if (reqOrigin && allowed.includes(reqOrigin)) return reqOrigin;
  return config.FRONTEND_HOST.split(',')[0].trim();
}

function apiBase(req: { protocol: string; get(name: string): string | undefined }) {
  return publicApiBase(req);
}

function truthy(value: unknown) {
  return value === true || value === 'true' || value === 'True';
}

async function loadUnpaidOrder(orderNumber: string, phone?: string) {
  const orderRes = await pool.query('SELECT * FROM orders WHERE order_number = $1', [orderNumber]);
  if (!orderRes.rowCount) throw new HttpError(404, 'الطلب غير موجود');
  const order = orderRes.rows[0];
  if (phone && String(order.phone) !== String(phone)) {
    throw new HttpError(403, 'بيانات الطلب غير مطابقة');
  }
  if (order.payment_status === 'paid') {
    throw new HttpError(400, 'تم دفع هذا الطلب بالفعل');
  }
  return order;
}

/** Which payment methods the storefront may offer (no secrets). */
router.get(
  '/methods',
  asyncWrapper(async (_req, res) => {
    ok(res, {
      currency: config.STORE_CURRENCY,
      cod: true,
      paymob: paymobConfigured(),
      tamara: {
        enabled: tamaraConfigured(),
        min_amount: config.TAMARA_MIN_AMOUNT || null,
        max_amount: config.TAMARA_MAX_AMOUNT || null,
        public_key: config.TAMARA_PUBLIC_KEY || null,
        country: config.TAMARA_COUNTRY_CODE,
        locale: config.TAMARA_LOCALE,
      },
    });
  }),
);

/** Tamara pre-checkout eligibility + amount range check for the checkout page. */
router.post(
  '/tamara/eligibility',
  validate(
    z.object({
      phone: z.string().min(8).optional(),
      amount: z.coerce.number().positive(),
    }),
  ),
  asyncWrapper(async (req, res) => {
    if (!tamaraConfigured()) {
      ok(res, { is_eligible: false, reason: 'not_configured' });
      return;
    }
    if (!tamaraAmountAllowed(req.body.amount)) {
      ok(res, { is_eligible: false, reason: 'amount_out_of_range' });
      return;
    }
    const eligible = await checkTamaraEligibility({
      phone: req.body.phone,
      amount: req.body.amount,
    });
    ok(res, { is_eligible: eligible, reason: eligible ? null : 'customer_not_eligible' });
  }),
);

router.post(
  '/paymob/session',
  optionalAuth(),
  validate(
    z.object({
      order_number: z.string().min(3),
      phone: z.string().min(8).optional(),
    }),
  ),
  asyncWrapper(async (req, res) => {
    if (!paymobConfigured()) throw new HttpError(503, 'الدفع الإلكتروني غير مُعد');
    const order = await loadUnpaidOrder(req.body.order_number, req.body.phone);
    const address = order.shipping_address_json || {};
    const session = await createPaymobCheckout({
      order,
      billing: {
        full_name: address.full_name,
        phone: order.phone,
        email: order.guest_email,
        city: address.city,
        address_line1: address.address_line1 || order.shipping_address,
      },
      frontendReturn: frontendBase(req.get('origin')),
      apiPublicBase: apiBase(req),
    });
    created(res, {
      checkout_url: session.checkoutUrl,
      checkoutUrl: session.checkoutUrl,
      clientSecret: session.clientSecret,
      paymentToken: session.paymentToken,
      order_number: order.order_number,
      payment_provider: 'paymob',
    });
  }),
);

router.post(
  '/tamara/session',
  optionalAuth(),
  validate(
    z.object({
      order_number: z.string().min(3),
      phone: z.string().min(8).optional(),
    }),
  ),
  asyncWrapper(async (req, res) => {
    if (!tamaraConfigured()) throw new HttpError(503, 'تمارا غير مُعد');
    const order = await loadUnpaidOrder(req.body.order_number, req.body.phone);
    const address = order.shipping_address_json || {};
    const session = await createTamaraCheckout({
      order,
      billing: {
        full_name: address.full_name as string | undefined,
        phone: order.phone,
        email: order.guest_email,
        city: address.city as string | undefined,
        address_line1: (address.address_line1 as string | undefined) || order.shipping_address,
      },
      frontendReturn: frontendBase(req.get('origin')),
      apiPublicBase: apiBase(req),
    });
    created(res, {
      checkout_url: session.checkoutUrl,
      checkoutUrl: session.checkoutUrl,
      clientSecret: session.clientSecret,
      paymentToken: session.paymentToken,
      order_number: order.order_number,
      payment_provider: 'tamara',
      tamara_order_id: session.tamaraOrderId,
    });
  }),
);

/** Unified retry: routes to Paymob or Tamara based on payments.provider */
router.post(
  '/session',
  optionalAuth(),
  validate(
    z.object({
      order_number: z.string().min(3),
      phone: z.string().min(8).optional(),
    }),
  ),
  asyncWrapper(async (req, res) => {
    const order = await loadUnpaidOrder(req.body.order_number, req.body.phone);
    const pay = await pool.query(
      `SELECT provider FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
      [order.id],
    );
    const provider = String(pay.rows[0]?.provider || '').toLowerCase();
    const address = order.shipping_address_json || {};
    const billing = {
      full_name: address.full_name as string | undefined,
      phone: order.phone as string | undefined,
      email: order.guest_email as string | null | undefined,
      city: address.city as string | undefined,
      address_line1: (address.address_line1 as string | undefined) || order.shipping_address,
    };
    const common = {
      order,
      billing,
      frontendReturn: frontendBase(req.get('origin')),
      apiPublicBase: apiBase(req),
    };

    if (provider === 'tamara') {
      if (!tamaraConfigured()) throw new HttpError(503, 'تمارا غير مُعد');
      const session = await createTamaraCheckout(common);
      created(res, {
        checkout_url: session.checkoutUrl,
        checkoutUrl: session.checkoutUrl,
        clientSecret: session.clientSecret,
        paymentToken: session.paymentToken,
        order_number: order.order_number,
        payment_provider: 'tamara',
      });
      return;
    }

    if (!paymobConfigured()) throw new HttpError(503, 'الدفع الإلكتروني غير مُعد');
    const session = await createPaymobCheckout(common);
    created(res, {
      checkout_url: session.checkoutUrl,
      checkoutUrl: session.checkoutUrl,
      clientSecret: session.clientSecret,
      paymentToken: session.paymentToken,
      order_number: order.order_number,
      payment_provider: 'paymob',
    });
  }),
);

router.post(
  '/paymob/webhook',
  asyncWrapper(async (req, res) => {
    const obj = (req.body?.obj ?? req.body) as Record<string, unknown> | undefined;
    const received = String(req.query.hmac ?? req.body?.hmac ?? '');
    if (!obj || !verifyPaymobHmac(obj, received)) {
      res.status(401).json({ message: 'Invalid HMAC' });
      return;
    }

    const merchantOrderId =
      (typeof obj.merchant_order_id === 'string' && obj.merchant_order_id) ||
      (obj.order &&
      typeof obj.order === 'object' &&
      typeof (obj.order as { merchant_order_id?: string }).merchant_order_id === 'string'
        ? (obj.order as { merchant_order_id: string }).merchant_order_id
        : null) ||
      (obj.payment_key_claims &&
      typeof obj.payment_key_claims === 'object' &&
      typeof (obj.payment_key_claims as { extra?: { order_number?: string } }).extra
        ?.order_number === 'string'
        ? (obj.payment_key_claims as { extra: { order_number: string } }).extra.order_number
        : null);

    await applyPaymobResult({
      merchantOrderId,
      success: truthy(obj.success),
      pending: truthy(obj.pending),
      transactionId: obj.id != null ? String(obj.id) : null,
      raw: obj,
    });
    res.status(200).json({ received: true });
  }),
);

router.post(
  '/tamara/webhook',
  asyncWrapper(async (req, res) => {
    const authHeader = String(req.get('authorization') || '');
    const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const token = String(req.query.tamaraToken || bearer || '');
    if (!verifyTamaraWebhookToken(token)) {
      res.status(401).json({ message: 'Invalid Tamara token' });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    await applyTamaraWebhook({
      eventType: body.event_type != null ? String(body.event_type) : null,
      orderId: body.order_id != null ? String(body.order_id) : null,
      orderReferenceId: body.order_reference_id != null ? String(body.order_reference_id) : null,
      orderNumber: body.order_number != null ? String(body.order_number) : null,
      raw: body,
    });
    res.status(200).json({ received: true });
  }),
);

router.get(
  '/paymob/return',
  asyncWrapper(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const received = String(q.hmac ?? '');
    const verified = received ? verifyPaymobHmac(q, received) : false;
    const merchantOrderId = String(q.merchant_order_id ?? q.special_reference ?? '');

    if (verified) {
      await applyPaymobResult({
        merchantOrderId,
        success: truthy(q.success),
        pending: truthy(q.pending),
        transactionId: q.id != null ? String(q.id) : null,
        raw: q,
      });
    }

    let next = frontendBase(null);
    const order = await findOrderByPaymobReference(merchantOrderId);
    if (order) {
      const pay = await pool.query(
        `SELECT raw_payload FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
        [order.id],
      );
      const stored = pay.rows[0]?.raw_payload?.frontend_return;
      if (typeof stored === 'string' && stored.startsWith('http')) next = stored;
    }

    const success = verified && truthy(q.success) && !truthy(q.pending);
    const url = new URL('/checkout/result', next);
    url.searchParams.set('success', success ? '1' : '0');
    if (order?.order_number) url.searchParams.set('order_number', order.order_number);
    url.searchParams.set('provider', 'paymob');
    if (!verified) url.searchParams.set('pending', '1');
    res.redirect(url.toString());
  }),
);

async function tamaraReturnRedirect(
  res: { redirect(url: string): void },
  opts: { orderNumber: string; successHint: boolean; cancelled?: boolean },
) {
  let paid = false;
  let next = frontendBase(null);
  if (opts.orderNumber) {
    const synced = await syncTamaraReturn(opts.orderNumber);
    paid = Boolean(synced?.paid);
    const pay = await pool.query(
      `SELECT p.raw_payload
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE o.order_number = $1
       ORDER BY p.id DESC LIMIT 1`,
      [opts.orderNumber],
    );
    const stored = pay.rows[0]?.raw_payload?.frontend_return;
    if (typeof stored === 'string' && stored.startsWith('http')) next = stored;
  }

  const url = new URL('/checkout/result', next);
  url.searchParams.set('success', paid ? '1' : '0');
  if (opts.orderNumber) url.searchParams.set('order_number', opts.orderNumber);
  if (!paid && opts.successHint) url.searchParams.set('pending', '1');
  if (opts.cancelled) url.searchParams.set('cancelled', '1');
  url.searchParams.set('provider', 'tamara');
  res.redirect(url.toString());
}

router.get(
  '/tamara/return/success',
  asyncWrapper(async (req, res) => {
    const orderNumber = String(req.query.order_number || req.query.orderId || '');
    await tamaraReturnRedirect(res, { orderNumber, successHint: true });
  }),
);

router.get(
  '/tamara/return/failure',
  asyncWrapper(async (req, res) => {
    const orderNumber = String(req.query.order_number || req.query.orderId || '');
    await tamaraReturnRedirect(res, { orderNumber, successHint: false });
  }),
);

router.get(
  '/tamara/return/cancel',
  asyncWrapper(async (req, res) => {
    const orderNumber = String(req.query.order_number || req.query.orderId || '');
    await tamaraReturnRedirect(res, { orderNumber, successHint: false, cancelled: true });
  }),
);
