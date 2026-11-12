import pool from '../db/pool';
import { logger } from '../utils';
import { cancelTamaraOrder, tamaraOrderIdFor } from './tamara';

export type PaymentSideEffectResult = {
  /** Provider action taken (or required), if any. */
  action?: 'tamara_cancel' | 'manual_refund_required';
  ok: boolean;
  /** Human-readable warning for the admin when something needs attention. */
  warning?: string;
};

type PaymentRow = {
  provider: string | null;
  raw_payload: Record<string, unknown> | null;
};

async function latestPayment(orderId: number): Promise<PaymentRow | null> {
  const res = await pool.query(
    `SELECT provider, raw_payload FROM payments
     WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
    [orderId],
  );
  return res.rows[0] ?? null;
}

async function note(orderId: number, status: string, text: string) {
  await pool.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, note)
     VALUES ($1, $2, $2, $3)`,
    [orderId, status, text],
  );
}

async function mergePayload(orderId: number, patch: Record<string, unknown>) {
  await pool.query(
    `UPDATE payments
     SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE id = (SELECT id FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1)`,
    [orderId, JSON.stringify(patch)],
  );
}

/**
 * Decide what a cancelled order needs from its payment provider. Pure — exported for tests.
 * Refunds are never issued automatically; they are handled manually in the provider dashboards.
 */
export function planCancellation(input: {
  provider: string | null | undefined;
  paymentStatus: string | null | undefined;
  captured: boolean;
}): PaymentSideEffectResult['action'] | null {
  if (input.paymentStatus !== 'paid') return null;
  const provider = String(input.provider || '').toLowerCase();
  // Authorised (not yet captured) Tamara orders must be cancelled at Tamara, otherwise
  // Tamara auto-captures after 21 days and the customer keeps paying for a cancelled order.
  if (provider === 'tamara') return input.captured ? 'manual_refund_required' : 'tamara_cancel';
  if (provider === 'paymob') return 'manual_refund_required';
  return null;
}

/** Called after an order moved to `cancelled` (admin, WhatsApp, customer). */
export async function onOrderCancelled(
  orderId: number,
  reason = 'Order cancelled',
): Promise<PaymentSideEffectResult> {
  try {
    const orderRes = await pool.query(
      'SELECT id, status, payment_status, total FROM orders WHERE id = $1',
      [orderId],
    );
    const order = orderRes.rows[0];
    const payment = await latestPayment(orderId);
    if (!order || !payment) return { ok: true };

    const action = planCancellation({
      provider: payment.provider,
      paymentStatus: order.payment_status,
      captured: Boolean(payment.raw_payload?.captured_at),
    });
    if (!action) return { ok: true };

    if (action === 'manual_refund_required') {
      const provider = String(payment.provider) === 'tamara' ? 'تمارا' : 'Paymob';
      await note(orderId, order.status, `Paid via ${payment.provider} — manual refund required`);
      return {
        action,
        ok: true,
        warning: `هذا الطلب مدفوع عبر ${provider}. لا يتم الاسترداد تلقائياً — نفّذ الاسترداد يدوياً من لوحة ${provider}.`,
      };
    }

    const tamaraOrderId = await tamaraOrderIdFor(orderId);
    if (!tamaraOrderId) {
      await note(orderId, order.status, 'Tamara order id missing — cancel it manually in Tamara');
      return {
        action,
        ok: false,
        warning: 'لا يوجد رقم طلب تمارا محفوظ — ألغِ الطلب يدوياً من بوابة تمارا.',
      };
    }

    const result = await cancelTamaraOrder({ tamaraOrderId, amount: order.total });
    if (result.ok) {
      await mergePayload(orderId, {
        tamara_cancel_at: new Date().toISOString(),
        tamara_cancel: result.json,
        tamara_cancel_reason: reason,
      });
      await pool.query(
        `UPDATE orders SET payment_status = 'refunded', updated_at = NOW() WHERE id = $1`,
        [orderId],
      );
      await pool.query(
        `UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE order_id = $1`,
        [orderId],
      );
      await note(orderId, order.status, 'Tamara order cancelled (customer released)');
      return { action, ok: true };
    }

    const detail = JSON.stringify(result.json ?? {}).slice(0, 200);
    await mergePayload(orderId, { tamara_cancel_error: result.json ?? null });
    await note(orderId, order.status, `Tamara cancel FAILED: ${detail}`);
    return {
      action,
      ok: false,
      warning: `فشل إلغاء الطلب في تمارا — ألغِه يدوياً من بوابة تمارا. ${detail}`,
    };
  } catch (err) {
    logger.error({ err, orderId }, '[payments] cancellation side effect failed');
    return { ok: false, warning: 'تعذر إبلاغ مزود الدفع بالإلغاء — راجع السجلات.' };
  }
}
