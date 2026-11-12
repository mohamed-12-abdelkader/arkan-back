import crypto from 'node:crypto';
import pool from '../db/pool';
import { config, HttpError, logger } from '../utils';
import { maybeNotifyOrderWhatsApp } from './whatsapp';

type Billing = {
  full_name?: string;
  phone?: string;
  email?: string | null;
  city?: string;
  address_line1?: string;
};

type OrderRow = {
  id: number;
  order_number: string;
  total: string | number;
  phone?: string | null;
  guest_email?: string | null;
};

const HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
] as const;

function hmacValue(source: Record<string, unknown>, key: string): string {
  if (key === 'order') {
    const order = source.order;
    if (order && typeof order === 'object' && 'id' in (order as object)) {
      return String((order as { id: unknown }).id ?? '');
    }
    return String(order ?? source.order_id ?? '');
  }
  if (key.startsWith('source_data.')) {
    const part = key.slice('source_data.'.length);
    const nested = source.source_data;
    if (nested && typeof nested === 'object' && part in (nested as object)) {
      const value = (nested as Record<string, unknown>)[part];
      return value == null ? '' : String(value);
    }
    const flat = source[key];
    return flat == null ? '' : String(flat);
  }
  const value = source[key];
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value == null ? '' : String(value);
}

export function verifyPaymobHmac(source: Record<string, unknown>, received: string): boolean {
  if (!config.PAYMOB_HMAC || !received) return false;
  const concatenated = HMAC_FIELDS.map((key) => hmacValue(source, key)).join('');
  const computed = crypto
    .createHmac('sha512', config.PAYMOB_HMAC)
    .update(concatenated)
    .digest('hex');
  const a = Buffer.from(computed);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function integrationId(): number {
  const raw = config.PAYMOB_INTEGRATION_ID.trim();
  const number = Number(raw);
  if (!raw) {
    throw new HttpError(
      500,
      'معرف التكامل غير موجود. يرجى التحقق من PAYMOB_INTEGRATION_ID في ملف .env',
    );
  }
  if (!Number.isFinite(number) || number <= 0) {
    throw new HttpError(500, 'معرف التكامل غير صحيح. يجب أن يكون رقماً صحيحاً');
  }
  return number;
}

function specialReference(orderId: number) {
  const random = Math.random().toString(36).slice(2, 9);
  return `order-${orderId}-${Date.now()}-${random}`;
}

/** Paymob KSA expects an international phone number, e.g. +9665XXXXXXXX. */
export function toPaymobPhone(raw: string | null | undefined): string {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!digits) return '';
  if (digits.startsWith('966')) return `+${digits}`;
  if (digits.startsWith('05') && digits.length === 10) return `+966${digits.slice(1)}`;
  if (digits.startsWith('5') && digits.length === 9) return `+966${digits}`;
  return `+${digits}`;
}

function splitName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || 'Customer',
    last_name: parts.slice(1).join(' ') || 'Store',
  };
}

export function paymobConfigured() {
  return Boolean(config.PAYMOB_SECRET_KEY && config.PAYMOB_PUBLIC_KEY);
}

export async function createPaymobCheckout(opts: {
  order: OrderRow;
  billing: Billing;
  frontendReturn: string;
  apiPublicBase: string;
}) {
  if (!paymobConfigured()) {
    throw new HttpError(503, 'الدفع الإلكتروني غير مُعد. أضف مفاتيح Paymob.');
  }

  const amountCents = Math.round(Number(opts.order.total) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new HttpError(400, 'مبلغ الطلب غير صالح للدفع');
  }

  const integration = integrationId();
  const reference = specialReference(opts.order.id);
  const { first_name, last_name } = splitName(opts.billing.full_name || 'Customer');
  const phone = toPaymobPhone(opts.billing.phone || opts.order.phone);
  if (!phone) throw new HttpError(400, 'رقم الجوال مطلوب للدفع الإلكتروني');
  const email = opts.billing.email || opts.order.guest_email || `guest-${opts.order.id}@arkan.shop`;
  const apiBase = config.PAYMOB_BASE_URL.replace(/\/$/, '');
  const redirection =
    config.PAYMOB_REDIRECTION_URL || `${opts.frontendReturn.replace(/\/$/, '')}/checkout/result`;

  const payload = {
    amount: amountCents,
    currency: config.PAYMOB_CURRENCY || 'SAR',
    payment_methods: [integration],
    items: [
      {
        name: `Order ${opts.order.order_number}`,
        amount: amountCents,
        description: opts.order.order_number,
        quantity: 1,
      },
    ],
    billing_data: {
      apartment: 'N/A',
      first_name,
      last_name: last_name || first_name,
      street: opts.billing.address_line1 || 'N/A',
      building: 'N/A',
      phone_number: phone,
      city: opts.billing.city || 'N/A',
      country: config.PAYMOB_COUNTRY || 'SA',
      email,
      floor: 'N/A',
      state: 'N/A',
    },
    special_reference: reference,
    notification_url:
      config.PAYMOB_NOTIFICATION_URL ||
      `${opts.apiPublicBase.replace(/\/$/, '')}/api/v1/payments/paymob/webhook`,
    redirection_url: redirection,
    extras: {
      order_id: opts.order.id,
      order_number: opts.order.order_number,
      frontend_return: opts.frontendReturn,
    },
  };

  const response = await fetch(`${apiBase}/v1/intention/`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.PAYMOB_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !json?.client_secret) {
    logger.error({ status: response.status, body: json }, 'Paymob intention failed');
    let detail =
      (typeof json?.detail === 'string' && json.detail) ||
      (typeof json?.message === 'string' && json.message) ||
      (json ? JSON.stringify(json).slice(0, 280) : 'تعذر بدء الدفع مع Paymob');
    if (/integration id does not exist/i.test(detail)) {
      detail = `Paymob لا يعرف رقم التكامل ${config.PAYMOB_INTEGRATION_ID} لهذه المفاتيح. تأكد أن المفاتيح ورقم التكامل من نفس الوضع (Test أو Live).`;
    }
    throw new HttpError(502, detail);
  }

  const clientSecret = String(json.client_secret);
  const paymentToken = json.payment_token != null ? String(json.payment_token) : null;
  const checkoutUrl = `${apiBase}/unifiedcheckout/?publicKey=${config.PAYMOB_PUBLIC_KEY}&clientSecret=${clientSecret}`;

  await pool.query(
    `UPDATE payments
     SET provider = 'paymob',
         method = 'card',
         currency = $2,
         provider_ref = $3,
         raw_payload = $4::jsonb,
         updated_at = NOW()
     WHERE order_id = $1`,
    [
      opts.order.id,
      config.PAYMOB_CURRENCY,
      paymentToken,
      JSON.stringify({
        intention_id: json.id ?? null,
        paymob_order_id: json.intention_order_id ?? null,
        special_reference: reference,
        frontend_return: opts.frontendReturn,
        client_secret: clientSecret,
        payment_token: paymentToken,
      }),
    ],
  );

  return {
    checkoutUrl,
    clientSecret,
    paymentToken,
    intentionId: json.id ?? null,
  };
}

/**
 * Resolve an order from the Paymob merchant reference (`order-<id>-<ts>-<rand>`),
 * a stored special_reference, or a plain order number.
 */
export async function findOrderByPaymobReference(reference: string | null | undefined) {
  const ref = reference?.trim();
  if (!ref) return null;
  const orderIdMatch = /^order-(\d+)-/.exec(ref);
  const orderRes = orderIdMatch
    ? await pool.query('SELECT * FROM orders WHERE id = $1', [Number(orderIdMatch[1])])
    : await pool.query(
        `SELECT o.* FROM orders o
         LEFT JOIN payments p ON p.order_id = o.id
         WHERE o.order_number = $1 OR p.raw_payload->>'special_reference' = $1
         ORDER BY o.id DESC LIMIT 1`,
        [ref],
      );
  return orderRes.rowCount ? orderRes.rows[0] : null;
}

export async function applyPaymobResult(input: {
  merchantOrderId?: string | null;
  success: boolean;
  pending: boolean;
  transactionId?: string | null;
  raw: unknown;
}) {
  const order = await findOrderByPaymobReference(input.merchantOrderId);
  if (!order) return null;

  if (input.success && !input.pending) {
    let shouldNotifyWhatsApp = false;
    if (order.payment_status !== 'paid') {
      // glassShop-style: after payment stay pending, then WA send moves to awaiting_confirmation
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
           VALUES ($1, $2, 'pending', 'Paymob payment succeeded')`,
          [order.id, order.status],
        );
      }
    }
    await pool.query(
      `UPDATE payments
       SET status = 'paid', provider_ref = COALESCE($2, provider_ref),
           raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       WHERE order_id = $1`,
      [order.id, input.transactionId ?? null, JSON.stringify({ callback: input.raw })],
    );
    if (shouldNotifyWhatsApp) {
      await maybeNotifyOrderWhatsApp(order.id);
    }
    return { ...order, payment_status: 'paid', paid: true };
  }

  if (!input.success && !input.pending && order.payment_status !== 'paid') {
    await pool.query(
      `UPDATE orders SET payment_status = 'failed', updated_at = NOW() WHERE id = $1`,
      [order.id],
    );
    await pool.query(
      `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE order_id = $1`,
      [order.id],
    );
  }

  return { ...order, paid: false };
}
