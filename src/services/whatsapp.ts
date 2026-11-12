import crypto from 'node:crypto';
import pool from '../db/pool';
import { config, logger } from '../utils';

const ORDER_CONFIRM_SESSION_KEY = 'whatsapp_order_confirm_session';

function gatewayBase() {
  return (config.WHATSAPP_GATEWAY_URL || '').replace(/\/$/, '');
}

export function isWhatsAppConfigured(): boolean {
  return Boolean(gatewayBase() && config.WHATSAPP_API_KEY);
}

async function waFetch(path: string, init: RequestInit = {}) {
  if (!isWhatsAppConfigured()) {
    throw new Error('WhatsApp gateway is not configured');
  }
  const res = await fetch(`${gatewayBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_API_KEY}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(
      typeof data === 'object' && data?.message
        ? String(data.message)
        : `WhatsApp gateway error (${res.status})`,
    ) as Error & { status?: number; detail?: unknown };
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

export async function getOrderConfirmSessionId(): Promise<string | null> {
  const row = await pool.query(`SELECT value FROM store_settings WHERE key = $1 LIMIT 1`, [
    ORDER_CONFIRM_SESSION_KEY,
  ]);
  if (!row.rowCount) return null;
  const value = row.rows[0].value;
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object' && typeof value.session_id === 'string') {
    return value.session_id || null;
  }
  return null;
}

export async function setOrderConfirmSessionId(sessionId: string | null): Promise<void> {
  if (!sessionId) {
    await pool.query(`DELETE FROM store_settings WHERE key = $1`, [ORDER_CONFIRM_SESSION_KEY]);
    return;
  }
  await pool.query(
    `INSERT INTO store_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [ORDER_CONFIRM_SESSION_KEY, JSON.stringify({ session_id: sessionId })],
  );
}

/** Normalize phone to WhatsApp digits (E.164 without +). Defaults to Egypt (20). */
export function normalizePhone(phone: string): string {
  let digits = phone.replace(/[^0-9]/g, '');

  if (digits.startsWith('00')) digits = digits.slice(2);

  if (
    digits.startsWith('20') ||
    digits.startsWith('966') ||
    digits.startsWith('971') ||
    digits.startsWith('973') ||
    digits.startsWith('965') ||
    digits.startsWith('974')
  ) {
    return digits;
  }

  // Egypt mobile
  if (digits.startsWith('01') && digits.length === 11) {
    return `20${digits.slice(1)}`;
  }
  if (/^1[0125]\d{8}$/.test(digits)) {
    return `20${digits}`;
  }

  // Saudi fallback (legacy gateway shops)
  if (digits.startsWith('05') && digits.length === 10) {
    return `966${digits.slice(1)}`;
  }
  if (digits.startsWith('5') && digits.length === 9) {
    return `966${digits}`;
  }

  return digits;
}

export async function listSessions() {
  return waFetch('/v1/sessions');
}

export async function getSession(id: string) {
  return waFetch(`/v1/sessions/${encodeURIComponent(id)}`);
}

export async function createSession(id: string) {
  return waFetch('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

export async function deleteSession(id: string) {
  return waFetch(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function reconnectSession(id: string) {
  return waFetch(`/v1/sessions/${encodeURIComponent(id)}/reconnect`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function sendMessage(params: {
  sessionId: string;
  to: string;
  body: string;
  metadata?: Record<string, unknown>;
}) {
  return waFetch('/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      session_id: params.sessionId,
      to: normalizePhone(params.to),
      body: params.body,
      metadata: params.metadata ?? {},
    }),
  });
}

export type SendConfirmResult = { ok: true; sessionId: string } | { ok: false; reason: string };

function formatMoney(amount: string | number): string {
  const n = Number(amount || 0);
  const formatted = n.toLocaleString('ar-SA', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return config.STORE_CURRENCY === 'SAR'
    ? `${formatted} ر.س`
    : `${formatted} ${config.STORE_CURRENCY}`;
}

function paymentMethodLabel(method: string | null | undefined): string {
  if (!method) return 'غير محدد';
  if (method === 'cod' || method === 'cash_on_delivery') return 'الدفع عند الاستلام';
  if (method === 'paymob' || method === 'card') return 'دفع إلكتروني';
  if (method === 'tamara') return 'تمارا';
  if (method === 'bank_transfer') return 'تحويل بنكي';
  return method;
}

function buildOrderConfirmBody(order: {
  id: number;
  order_number: string;
  total: string | number;
  shipping_total?: string | number;
  subtotal?: string | number;
  phone?: string | null;
  shipping_address?: string | null;
  shipping_address_json?: any;
  items: Array<{
    product_name: string;
    quantity: number;
    price: string | number;
    line_total?: string | number;
  }>;
  payment_method?: string | null;
}): string {
  const lines = order.items.map((d) => {
    const lineTotal = d.line_total ?? Number(d.price) * Number(d.quantity);
    return `• ${d.product_name} × ${d.quantity} — ${formatMoney(lineTotal)}`;
  });

  const address = order.shipping_address_json?.address_line1 || order.shipping_address || '—';
  const city = order.shipping_address_json?.city || order.shipping_address_json?.governorate;

  const parts = [
    `طلبك رقم ${order.order_number}`,
    '',
    'تفاصيل الطلب:',
    ...lines,
    '',
    `المنتجات: ${formatMoney(order.subtotal ?? order.total)}`,
    `الشحن: ${formatMoney(order.shipping_total ?? 0)}`,
    `الإجمالي: ${formatMoney(order.total)}`,
    '',
    `العنوان: ${address}`,
  ];
  if (city) parts.push(`المدينة: ${city}`);
  parts.push(`طريقة الدفع: ${paymentMethodLabel(order.payment_method)}`);
  parts.push('');
  parts.push('للتأكيد أرسل: نعم');
  parts.push('للإلغاء أرسل: لا');
  return parts.join('\n');
}

export async function sendOrderConfirmRequest(params: {
  orderId: number;
  phoneNumber?: string | null;
}): Promise<SendConfirmResult> {
  if (!isWhatsAppConfigured()) {
    return { ok: false, reason: 'whatsapp_not_configured' };
  }

  const sessionId = await getOrderConfirmSessionId();
  if (!sessionId) {
    logger.warn('[whatsapp] skip order confirm: no session assigned');
    return { ok: false, reason: 'no_session_assigned' };
  }

  const orderRes = await pool.query(`SELECT * FROM orders WHERE id = $1`, [params.orderId]);
  if (!orderRes.rowCount) return { ok: false, reason: 'order_not_found' };
  const order = orderRes.rows[0];

  const phone = params.phoneNumber || order.phone;
  if (!phone) {
    logger.warn({ orderId: params.orderId }, '[whatsapp] skip order confirm: no phone');
    return { ok: false, reason: 'no_phone' };
  }

  const items = await pool.query(
    `SELECT product_name, quantity, price, line_total FROM order_items WHERE order_id = $1`,
    [order.id],
  );
  const payment = await pool.query(
    `SELECT method, provider FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
    [order.id],
  );

  const body = buildOrderConfirmBody({
    id: order.id,
    order_number: order.order_number,
    total: order.total,
    shipping_total: order.shipping_total,
    subtotal: order.subtotal,
    phone: order.phone,
    shipping_address: order.shipping_address,
    shipping_address_json: order.shipping_address_json,
    items: items.rows,
    payment_method: payment.rows[0]?.method || payment.rows[0]?.provider,
  });

  try {
    await sendMessage({
      sessionId,
      to: phone,
      body,
      metadata: {
        feature: 'order_confirm',
        order_id: String(order.id),
        order_number: order.order_number,
      },
    });
    logger.info(
      { orderId: order.id, to: normalizePhone(phone), sessionId },
      '[whatsapp] order confirm sent',
    );
    return { ok: true, sessionId };
  } catch (err) {
    logger.error({ err, orderId: order.id }, '[whatsapp] failed to send order confirm');
    return { ok: false, reason: 'send_failed' };
  }
}

/**
 * Same flow as glassShop:
 * - send WhatsApp confirm request
 * - ONLY if ok → move order to awaiting_confirmation
 * - if failed → keep current status (usually pending) for manual handling
 */
export async function maybeNotifyOrderWhatsApp(orderId: number) {
  const orderRes = await pool.query(`SELECT id, status, phone FROM orders WHERE id = $1`, [
    orderId,
  ]);
  if (!orderRes.rowCount) {
    return { ok: false as const, reason: 'order_not_found' };
  }
  const order = orderRes.rows[0];

  const result = await sendOrderConfirmRequest({
    orderId,
    phoneNumber: order.phone,
  });

  if (result.ok) {
    if (order.status !== 'awaiting_confirmation') {
      await pool.query(
        `UPDATE orders SET status = 'awaiting_confirmation', updated_at = NOW() WHERE id = $1`,
        [orderId],
      );
      await pool.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, note)
         VALUES ($1, $2, 'awaiting_confirmation', 'WhatsApp confirmation request sent')`,
        [orderId, order.status],
      );
    } else {
      await pool.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, note)
         VALUES ($1, $2, $2, 'WhatsApp confirmation request re-sent')`,
        [orderId, order.status],
      );
    }
    return result;
  }

  logger.warn(
    { orderId, reason: result.reason },
    '[whatsapp] confirm not sent — order left for manual confirmation (glassShop behavior)',
  );
  await pool.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, note)
     VALUES ($1, $2, $2, $3)`,
    [
      orderId,
      order.status,
      `WhatsApp confirm skipped (${result.reason}) — awaiting manual confirmation`,
    ],
  );
  return result;
}

export async function sendWhatsAppReply(params: {
  sessionId: string;
  to: string;
  body: string;
  orderId?: number;
}): Promise<void> {
  try {
    await sendMessage({
      sessionId: params.sessionId,
      to: params.to,
      body: params.body,
      metadata: params.orderId
        ? { feature: 'order_confirm_ack', order_id: String(params.orderId) }
        : { feature: 'order_confirm_ack' },
    });
  } catch (err) {
    logger.error({ err }, '[whatsapp] failed to send reply');
  }
}

export function verifyWebhookSignature(
  rawBody: Buffer | string | undefined,
  signatureHeader: string | undefined,
): boolean {
  const secret = config.WHATSAPP_WEBHOOK_SECRET;
  // Unsigned webhooks are only tolerated outside production.
  if (!secret) return config.NODE_ENV !== 'production';
  if (!rawBody || !signatureHeader) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  try {
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export { ORDER_CONFIRM_SESSION_KEY };
