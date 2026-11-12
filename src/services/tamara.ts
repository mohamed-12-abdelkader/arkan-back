import jwt from 'jsonwebtoken';
import pool from '../db/pool';
import { config, HttpError, logger } from '../utils';
import { maybeNotifyOrderWhatsApp } from './whatsapp';

type Billing = {
  full_name?: string;
  phone?: string;
  email?: string | null;
  city?: string;
  address_line1?: string;
  region?: string;
};

type OrderRow = {
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
  user_id?: number | null;
};

function money(value: string | number | null | undefined) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '0'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function amountObj(value: string | number | null | undefined) {
  return {
    amount: money(value),
    currency: config.TAMARA_CURRENCY || 'SAR',
  };
}

function splitName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || 'Customer',
    last_name: parts.slice(1).join(' ') || 'Store',
  };
}

/** Tamara expects local mobile without country prefix for GCC. */
export function normalizeTamaraPhone(raw: string) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('966') && digits.length > 9) digits = digits.slice(3);
  if (digits.startsWith('971') && digits.length > 9) digits = digits.slice(3);
  if (digits.startsWith('00')) digits = digits.replace(/^00/, '');
  if (digits.startsWith('0') && digits.length >= 9) digits = digits.slice(1);
  return digits;
}

/** VAT portion of a VAT-inclusive amount, using TAMARA_VAT_RATE (0 = not VAT-registered). */
export function vatPortion(total: number, rate = config.TAMARA_VAT_RATE) {
  if (!rate || rate <= 0) return 0;
  return Math.round((total - total / (1 + rate)) * 100) / 100;
}

/** Whether an order total is inside the configured Tamara range (0 = unbounded). */
export function tamaraAmountAllowed(
  amount: number,
  min = config.TAMARA_MIN_AMOUNT,
  max = config.TAMARA_MAX_AMOUNT,
) {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (min > 0 && amount < min) return false;
  if (max > 0 && amount > max) return false;
  return true;
}

async function riskAssessment(order: OrderRow, phone: string) {
  const today = ddMmYyyy();
  const history = await pool.query(
    `SELECT COUNT(*)::int AS total_orders,
            MIN(created_at) FILTER (WHERE payment_status = 'paid') AS first_paid,
            MAX(created_at) FILTER (WHERE payment_status = 'paid') AS last_paid
     FROM orders
     WHERE id <> $1 AND (($2::int IS NOT NULL AND user_id = $2) OR phone = $3)`,
    [order.id, order.user_id ?? null, order.phone ?? phone],
  );
  const h = history.rows[0] || {};
  let accountCreated = today;
  if (order.user_id) {
    const user = await pool.query('SELECT created_at FROM users WHERE id = $1', [order.user_id]);
    if (user.rows[0]?.created_at) accountCreated = ddMmYyyy(new Date(user.rows[0].created_at));
  }
  const risk: Record<string, unknown> = {
    is_premium_customer: false,
    is_guest_user: !order.user_id,
    account_creation_date: accountCreated,
    total_order_count: Number(h.total_orders) || 0,
  };
  if (h.first_paid) risk.date_first_paid = ddMmYyyy(new Date(h.first_paid));
  if (h.last_paid) risk.date_last_paid = ddMmYyyy(new Date(h.last_paid));
  return risk;
}

function ddMmYyyy(date = new Date()) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${d}-${m}-${date.getFullYear()}`;
}

export function tamaraConfigured() {
  return Boolean(config.TAMARA_API_TOKEN.trim());
}

function apiBase() {
  const base = (config.TAMARA_API_URL || 'https://api-sandbox.tamara.co').replace(/\/$/, '');
  return base;
}

async function tamaraFetch(path: string, init?: RequestInit) {
  if (!tamaraConfigured()) {
    throw new HttpError(503, 'تمارا غير مُعد. أضف TAMARA_API_TOKEN في ملف .env');
  }
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.TAMARA_API_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers || {}),
    },
  });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { response, json };
}

/**
 * Verify Tamara webhook JWT (tamaraToken query/Authorization).
 * Signed with HS256 using TAMARA_NOTIFICATION_TOKEN.
 */
export function verifyTamaraWebhookToken(token: string | null | undefined): boolean {
  const secret = config.TAMARA_NOTIFICATION_TOKEN.trim();
  const raw = String(token || '').trim();
  if (!secret || !raw) return false;
  try {
    jwt.verify(raw, secret, { algorithms: ['HS256'] });
    return true;
  } catch {
    return false;
  }
}

export async function createTamaraCheckout(opts: {
  order: OrderRow;
  billing: Billing;
  frontendReturn: string;
  apiPublicBase: string;
}) {
  if (!tamaraConfigured()) {
    throw new HttpError(503, 'تمارا غير مُعد. أضف TAMARA_API_TOKEN في ملف .env');
  }

  const total = money(opts.order.total);
  if (total <= 0) throw new HttpError(400, 'مبلغ الطلب غير صالح للدفع عبر تمارا');

  const currency = config.TAMARA_CURRENCY || 'SAR';
  const country = config.TAMARA_COUNTRY_CODE || 'SA';
  const fullName =
    opts.billing.full_name ||
    String(opts.order.shipping_address_json?.full_name || '') ||
    'Customer';
  const { first_name, last_name } = splitName(fullName);
  const phone = normalizeTamaraPhone(
    opts.billing.phone || opts.order.phone || String(opts.order.shipping_address_json?.phone || ''),
  );
  if (!phone) throw new HttpError(400, 'رقم الجوال مطلوب للدفع عبر تمارا');

  const email = opts.billing.email || opts.order.guest_email || `guest-${opts.order.id}@arkan.shop`;

  const city =
    opts.billing.city || String(opts.order.shipping_address_json?.city || '') || 'Riyadh';
  const line1 =
    opts.billing.address_line1 ||
    opts.order.shipping_address ||
    String(opts.order.shipping_address_json?.address_line1 || '') ||
    'N/A';

  const itemsRes = await pool.query(
    `SELECT id, product_id, product_name, quantity, price, line_total, sku
     FROM order_items WHERE order_id = $1 ORDER BY id`,
    [opts.order.id],
  );

  const items =
    itemsRes.rows.length > 0
      ? itemsRes.rows.map((row) => {
          const qty = Number(row.quantity) || 1;
          const line = money(row.line_total ?? Number(row.price) * qty);
          const unit = money(row.price ?? line / qty);
          return {
            reference_id: String(row.product_id || row.id),
            type: 'Physical',
            name: String(row.product_name || 'Item').slice(0, 255),
            sku: String(row.sku || `SKU-${row.id}`).slice(0, 128),
            quantity: qty,
            unit_price: { amount: unit, currency },
            total_amount: { amount: line, currency },
            tax_amount: { amount: 0, currency },
            discount_amount: { amount: 0, currency },
          };
        })
      : [
          {
            reference_id: String(opts.order.id),
            type: 'Physical',
            name: `Order ${opts.order.order_number}`.slice(0, 255),
            sku: opts.order.order_number.slice(0, 128),
            quantity: 1,
            unit_price: { amount: total, currency },
            total_amount: { amount: total, currency },
            tax_amount: { amount: 0, currency },
            discount_amount: { amount: 0, currency },
          },
        ];

  const frontend = opts.frontendReturn.replace(/\/$/, '');
  const api = opts.apiPublicBase.replace(/\/$/, '');
  const successBase = config.TAMARA_SUCCESS_URL || `${api}/api/v1/payments/tamara/return/success`;
  const failureBase = config.TAMARA_FAILURE_URL || `${api}/api/v1/payments/tamara/return/failure`;
  const cancelBase = config.TAMARA_CANCEL_URL || `${api}/api/v1/payments/tamara/return/cancel`;

  const withOrder = (base: string) => {
    const url = new URL(base);
    url.searchParams.set('order_number', opts.order.order_number);
    return url.toString();
  };

  const instalments = Number(config.TAMARA_INSTALMENTS) || 3;
  const paymentType = config.TAMARA_PAYMENT_TYPE || 'PAY_BY_INSTALMENTS';

  const payload: Record<string, unknown> = {
    order_reference_id: opts.order.order_number,
    order_number: opts.order.order_number,
    total_amount: { amount: total, currency },
    description: `Order ${opts.order.order_number}`.slice(0, 256),
    country_code: country,
    payment_type: paymentType,
    instalments,
    locale: config.TAMARA_LOCALE || 'ar_SA',
    platform: 'Arkan',
    items,
    consumer: {
      first_name,
      last_name,
      phone_number: phone,
      email,
    },
    shipping_address: {
      first_name,
      last_name,
      line1: String(line1).slice(0, 255),
      city,
      country_code: country,
      phone_number: phone,
      region: opts.billing.region || city,
    },
    billing_address: {
      first_name,
      last_name,
      line1: String(line1).slice(0, 255),
      city,
      country_code: country,
      phone_number: phone,
      region: opts.billing.region || city,
    },
    tax_amount: amountObj(money(opts.order.tax_total) || vatPortion(total)),
    shipping_amount: amountObj(opts.order.shipping_total ?? 0),
    merchant_url: {
      success: withOrder(successBase),
      failure: withOrder(failureBase),
      cancel: withOrder(cancelBase),
    },
    risk_assessment: await riskAssessment(opts.order, phone),
  };

  const discount = money(opts.order.discount_total);
  if (discount > 0) {
    payload.discount = {
      name: 'Order discount',
      amount: { amount: discount, currency },
    };
  }

  const { response, json } = await tamaraFetch('/checkout', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!response.ok || !json?.checkout_url || !json?.order_id) {
    logger.error({ status: response.status, body: json }, 'Tamara checkout failed');
    const detail =
      (typeof json?.message === 'string' && json.message) ||
      (Array.isArray(json?.errors) && JSON.stringify(json.errors).slice(0, 280)) ||
      (json ? JSON.stringify(json).slice(0, 280) : 'تعذر بدء الدفع مع تمارا');
    throw new HttpError(502, detail);
  }

  const checkoutUrl = String(json.checkout_url);
  const tamaraOrderId = String(json.order_id);
  const checkoutId = json.checkout_id != null ? String(json.checkout_id) : null;

  await pool.query(
    `UPDATE payments
     SET provider = 'tamara',
         method = 'tamara',
         currency = $2,
         provider_ref = $3,
         raw_payload = $4::jsonb,
         updated_at = NOW()
     WHERE order_id = $1`,
    [
      opts.order.id,
      currency,
      tamaraOrderId,
      JSON.stringify({
        tamara_order_id: tamaraOrderId,
        checkout_id: checkoutId,
        checkout_url: checkoutUrl,
        frontend_return: frontend,
        status: json.status ?? null,
      }),
    ],
  );

  return {
    checkoutUrl,
    tamaraOrderId,
    checkoutId,
    clientSecret: null as string | null,
    paymentToken: tamaraOrderId,
  };
}

export async function authoriseTamaraOrder(tamaraOrderId: string) {
  const { response, json } = await tamaraFetch(`/orders/${tamaraOrderId}/authorise`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    logger.warn({ status: response.status, body: json, tamaraOrderId }, 'Tamara authorise failed');
    return { ok: false as const, json };
  }
  return { ok: true as const, json };
}

export async function getTamaraOrder(tamaraOrderId: string) {
  const { response, json } = await tamaraFetch(`/orders/${tamaraOrderId}`, { method: 'GET' });
  if (!response.ok || !json) {
    return null;
  }
  return json;
}

export async function captureTamaraOrder(opts: {
  tamaraOrderId: string;
  total: string | number;
  shippingCompany?: string;
  trackingNumber?: string | null;
}) {
  const payload = {
    order_id: opts.tamaraOrderId,
    total_amount: amountObj(opts.total),
    shipping_amount: amountObj(0),
    tax_amount: amountObj(0),
    shipping_info: {
      shipped_at: new Date().toISOString(),
      shipping_company: (opts.shippingCompany || 'Arkan Shipping').slice(0, 100),
      tracking_number: opts.trackingNumber ? String(opts.trackingNumber).slice(0, 100) : undefined,
    },
  };
  const { response, json } = await tamaraFetch('/payments/capture', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    logger.warn(
      { status: response.status, body: json, tamaraOrderId: opts.tamaraOrderId },
      'Tamara capture failed',
    );
    return { ok: false as const, json };
  }
  return { ok: true as const, json };
}

async function findOrderForTamara(opts: {
  orderReferenceId?: string | null;
  orderNumber?: string | null;
  tamaraOrderId?: string | null;
}) {
  if (opts.tamaraOrderId) {
    const byRef = await pool.query(
      `SELECT o.* FROM orders o
       JOIN payments p ON p.order_id = o.id
       WHERE p.provider = 'tamara'
         AND (p.provider_ref = $1 OR p.raw_payload->>'tamara_order_id' = $1)
       ORDER BY o.id DESC LIMIT 1`,
      [opts.tamaraOrderId],
    );
    if (byRef.rowCount) return byRef.rows[0];
  }

  const ref = opts.orderReferenceId || opts.orderNumber;
  if (ref) {
    const byNumber = await pool.query(
      `SELECT * FROM orders WHERE order_number = $1 ORDER BY id DESC LIMIT 1`,
      [ref],
    );
    if (byNumber.rowCount) return byNumber.rows[0];
  }
  return null;
}

async function markTamaraPaid(
  order: OrderRow & { status: string; payment_status: string },
  raw: unknown,
) {
  let shouldNotifyWhatsApp = false;
  if (order.payment_status !== 'paid') {
    const nextStatus = order.status === 'pending_payment' ? 'pending' : order.status;
    shouldNotifyWhatsApp = order.status === 'pending_payment';
    await pool.query(
      `UPDATE orders
       SET payment_status = 'paid',
           status = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, nextStatus],
    );
    if (order.status === 'pending_payment') {
      await pool.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, note)
         VALUES ($1, $2, 'pending', 'Tamara payment authorised')`,
        [order.id, order.status],
      );
    }
  }

  await pool.query(
    `UPDATE payments
     SET status = 'paid',
         raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE order_id = $1`,
    [order.id, JSON.stringify({ callback: raw, paid_at: new Date().toISOString() })],
  );

  if (shouldNotifyWhatsApp) {
    await maybeNotifyOrderWhatsApp(order.id);
  }

  return { ...order, payment_status: 'paid', paid: true };
}

async function markTamaraFailed(order: OrderRow & { payment_status: string }, raw: unknown) {
  if (order.payment_status === 'paid') return { ...order, paid: true };
  await pool.query(
    `UPDATE orders SET payment_status = 'failed', updated_at = NOW() WHERE id = $1`,
    [order.id],
  );
  await pool.query(
    `UPDATE payments
     SET status = 'failed',
         raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE order_id = $1`,
    [order.id, JSON.stringify({ callback: raw })],
  );
  return { ...order, paid: false };
}

export async function applyTamaraWebhook(input: {
  eventType?: string | null;
  orderId?: string | null;
  orderReferenceId?: string | null;
  orderNumber?: string | null;
  raw: unknown;
}) {
  const event = String(input.eventType || '').toLowerCase();
  const order = await findOrderForTamara({
    tamaraOrderId: input.orderId,
    orderReferenceId: input.orderReferenceId,
    orderNumber: input.orderNumber,
  });
  if (!order) {
    logger.warn({ input }, 'Tamara webhook: order not found');
    return null;
  }

  const tamaraOrderId =
    input.orderId ||
    (
      await pool.query(
        `SELECT provider_ref, raw_payload FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
        [order.id],
      )
    ).rows[0]?.provider_ref;

  if (event === 'order_approved' || event === 'order_authorised' || event === 'order_authorized') {
    if (tamaraOrderId && event === 'order_approved') {
      const auth = await authoriseTamaraOrder(String(tamaraOrderId));
      if (!auth.ok) {
        // Auto-authorise may already move status; still try to sync as paid if authorised/captured
        const details = await getTamaraOrder(String(tamaraOrderId));
        const status = String(details?.status || '').toLowerCase();
        if (
          !['authorised', 'authorized', 'fully_captured', 'partially_captured'].includes(status)
        ) {
          await pool.query(
            `UPDATE payments
             SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb,
                 updated_at = NOW()
             WHERE order_id = $1`,
            [order.id, JSON.stringify({ authorise_error: auth.json, callback: input.raw })],
          );
          return { ...order, paid: false };
        }
      }
    }
    return markTamaraPaid(order, input.raw);
  }

  if (
    event === 'order_declined' ||
    event === 'order_expired' ||
    event === 'order_canceled' ||
    event === 'order_cancelled'
  ) {
    return markTamaraFailed(order, input.raw);
  }

  if (event === 'order_refunded') {
    await pool.query(
      `UPDATE payments
       SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE order_id = $1`,
      [order.id, JSON.stringify({ refunded_webhook: input.raw })],
    );
    await pool.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, note)
       VALUES ($1, $2, $2, 'Tamara refund confirmed by webhook')`,
      [order.id, order.status],
    );
    return { ...order, paid: order.payment_status === 'paid' };
  }

  if (event === 'order_captured') {
    await pool.query(
      `UPDATE payments
       SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE order_id = $1`,
      [order.id, JSON.stringify({ captured: input.raw })],
    );
    if (order.payment_status !== 'paid') {
      return markTamaraPaid(order, input.raw);
    }
    return { ...order, paid: true };
  }

  await pool.query(
    `UPDATE payments
     SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE order_id = $1`,
    [order.id, JSON.stringify({ webhook: input.raw })],
  );
  return { ...order, paid: order.payment_status === 'paid' };
}

export async function syncTamaraReturn(orderNumber: string) {
  const orderRes = await pool.query('SELECT * FROM orders WHERE order_number = $1', [orderNumber]);
  if (!orderRes.rowCount) return null;
  const order = orderRes.rows[0];
  const pay = await pool.query(
    `SELECT * FROM payments WHERE order_id = $1 AND provider = 'tamara' ORDER BY id DESC LIMIT 1`,
    [order.id],
  );
  if (!pay.rowCount) return { order, paid: order.payment_status === 'paid' };

  const tamaraOrderId =
    pay.rows[0].provider_ref || pay.rows[0].raw_payload?.tamara_order_id || null;
  if (!tamaraOrderId) return { order, paid: order.payment_status === 'paid' };

  const details = await getTamaraOrder(String(tamaraOrderId));
  const status = String(details?.status || '').toLowerCase();

  if (status === 'approved') {
    await authoriseTamaraOrder(String(tamaraOrderId));
    const paid = await markTamaraPaid(order, details);
    return { order: paid, paid: true };
  }

  if (['authorised', 'authorized', 'fully_captured', 'partially_captured'].includes(status)) {
    const paid = await markTamaraPaid(order, details);
    return { order: paid, paid: true };
  }

  if (['declined', 'expired', 'canceled', 'cancelled'].includes(status)) {
    await markTamaraFailed(order, details);
    return { order, paid: false };
  }

  return { order, paid: order.payment_status === 'paid' };
}

/** Capture after shipment for Tamara-paid orders (no-op if not Tamara / already captured). */
export async function maybeCaptureTamaraOnShip(
  orderId: number,
  note?: string | null,
): Promise<{ attempted: boolean; ok: boolean; error?: string }> {
  const pay = await pool.query(
    `SELECT * FROM payments WHERE order_id = $1 AND provider = 'tamara' ORDER BY id DESC LIMIT 1`,
    [orderId],
  );
  if (!pay.rowCount) return { attempted: false, ok: true };
  if (pay.rows[0].raw_payload?.captured_at) return { attempted: false, ok: true };

  const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!orderRes.rowCount || orderRes.rows[0].payment_status !== 'paid') {
    return { attempted: false, ok: true };
  }

  const tamaraOrderId = pay.rows[0].provider_ref || pay.rows[0].raw_payload?.tamara_order_id;
  if (!tamaraOrderId) return { attempted: false, ok: true };

  const result = await captureTamaraOrder({
    tamaraOrderId: String(tamaraOrderId),
    total: orderRes.rows[0].total,
    shippingCompany: 'Arkan Shipping',
    trackingNumber: note || null,
  });

  if (result.ok) {
    await pool.query(
      `UPDATE payments
       SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE order_id = $1`,
      [
        orderId,
        JSON.stringify({
          captured_at: new Date().toISOString(),
          capture: result.json,
        }),
      ],
    );
    return { attempted: true, ok: true };
  }
  return {
    attempted: true,
    ok: false,
    error: `Tamara capture failed: ${JSON.stringify(result.json ?? {}).slice(0, 200)}`,
  };
}

/** Tamara order id stored for a local order, if any. */
export async function tamaraOrderIdFor(orderId: number): Promise<string | null> {
  const pay = await pool.query(
    `SELECT provider_ref, raw_payload FROM payments
     WHERE order_id = $1 AND provider = 'tamara' ORDER BY id DESC LIMIT 1`,
    [orderId],
  );
  const row = pay.rows[0];
  const id = row?.provider_ref || row?.raw_payload?.tamara_order_id;
  return id ? String(id) : null;
}

/** Cancel (fully or partially) an authorised, not yet captured Tamara order. */
export async function cancelTamaraOrder(opts: { tamaraOrderId: string; amount: string | number }) {
  const { response, json } = await tamaraFetch(`/orders/${opts.tamaraOrderId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({
      total_amount: amountObj(opts.amount),
      shipping_amount: amountObj(0),
      tax_amount: amountObj(0),
      discount_amount: amountObj(0),
    }),
  });
  if (!response.ok) {
    logger.warn({ status: response.status, body: json, ...opts }, 'Tamara cancel failed');
    return { ok: false as const, json };
  }
  return { ok: true as const, json };
}

/**
 * Pre-checkout eligibility. Fails open (eligible) on timeout/error, as Tamara recommends,
 * so a slow API never hides the payment option.
 */
export async function checkTamaraEligibility(opts: {
  phone?: string | null;
  amount: number;
  timeoutMs?: number;
}): Promise<boolean> {
  if (!tamaraConfigured()) return false;
  const local = normalizeTamaraPhone(opts.phone || '');
  if (!local) return true;
  try {
    const response = await fetch(`${apiBase()}/pre-checkout/v1/eligibility`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.TAMARA_API_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        order: { amount: money(opts.amount), currency: config.TAMARA_CURRENCY || 'SAR' },
        customer: { phone_number: `966${local}` },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
    });
    if (!response.ok) return true;
    const json = (await response.json().catch(() => null)) as { is_eligible?: boolean } | null;
    return json?.is_eligible !== false;
  } catch {
    return true;
  }
}
