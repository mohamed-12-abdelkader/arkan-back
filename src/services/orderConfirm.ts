import pool from '../db/pool';
import { logger } from '../utils';
import { normalizePhone } from './whatsapp';

const ACTIONABLE = new Set(['pending', 'awaiting_confirmation', 'pending_payment']);

export function isActionableStatus(status: string): boolean {
  return ACTIONABLE.has(status);
}

export async function confirmOrder(
  orderId: number,
  source: 'whatsapp' | 'admin' = 'whatsapp',
): Promise<{ ok: boolean; status: string; message?: string }> {
  const orderRes = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  if (!orderRes.rowCount) {
    return { ok: false, status: 'pending', message: 'not found' };
  }
  const order = orderRes.rows[0];

  if (!isActionableStatus(order.status)) {
    return { ok: true, status: order.status, message: 'already handled' };
  }

  // pending_payment should not be confirmed via WhatsApp until paid
  if (order.status === 'pending_payment' && source === 'whatsapp') {
    return { ok: false, status: order.status, message: 'awaiting_payment' };
  }

  // glassShop moves to Processing; Arkan equivalent first ops status is confirmed
  const nextStatus = 'confirmed';
  await pool.query(
    `UPDATE orders
     SET status = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [order.id, nextStatus],
  );
  await pool.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, note)
     VALUES ($1, $2, $3, $4)`,
    [
      order.id,
      order.status,
      nextStatus,
      source === 'whatsapp'
        ? 'Customer confirmed via WhatsApp'
        : 'Order confirmed by admin',
    ],
  );

  logger.info({ orderId: order.id, source }, '[orderConfirm] confirmed');
  return { ok: true, status: nextStatus };
}

export async function cancelOrder(
  orderId: number,
  source: 'whatsapp' | 'admin' | 'user' = 'whatsapp',
): Promise<{ ok: boolean; status: string; message?: string }> {
  const orderRes = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  if (!orderRes.rowCount) {
    return { ok: false, status: 'pending', message: 'not found' };
  }
  const order = orderRes.rows[0];

  if (source === 'whatsapp' && !isActionableStatus(order.status)) {
    return { ok: true, status: order.status, message: 'already handled' };
  }

  if (order.status === 'cancelled') {
    return { ok: true, status: order.status, message: 'already handled' };
  }

  // WhatsApp cancel only while awaiting confirmation / pending (not after processing)
  if (source === 'whatsapp' && !['pending', 'awaiting_confirmation'].includes(order.status)) {
    return { ok: true, status: order.status, message: 'already handled' };
  }

  await pool.query(
    `UPDATE orders
     SET status = 'cancelled',
         fulfillment_status = 'cancelled',
         cancelled_reason = COALESCE(cancelled_reason, $2),
         updated_at = NOW()
     WHERE id = $1`,
    [
      order.id,
      source === 'whatsapp' ? 'Cancelled by customer via WhatsApp' : 'Cancelled',
    ],
  );
  await pool.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, note)
     VALUES ($1, $2, 'cancelled', $3)`,
    [
      order.id,
      order.status,
      source === 'whatsapp'
        ? 'Customer cancelled via WhatsApp'
        : `Cancelled (${source})`,
    ],
  );

  logger.info({ orderId: order.id, source }, '[orderConfirm] cancelled');
  return { ok: true, status: 'cancelled' };
}

export async function listOpenOrdersForPhone(phoneDigits: string) {
  const rows = await pool.query(
    `SELECT id, order_number, total, status, phone
     FROM orders
     WHERE status = ANY($1::text[])
     ORDER BY created_at DESC
     LIMIT 50`,
    [['pending', 'awaiting_confirmation']],
  );

  return rows.rows
    .filter((o) => o.phone && normalizePhone(String(o.phone)) === phoneDigits)
    .map((o) => ({
      id: Number(o.id),
      order_number: o.order_number as string,
      totalAmount: Number(o.total),
      status: String(o.status),
    }));
}
