import { Router } from 'express';
import pool from '../../db/pool';
import { asyncWrapper, logger } from '../../utils';
import {
  getOrderConfirmSessionId,
  normalizePhone,
  sendWhatsAppReply,
  verifyWebhookSignature,
} from '../../services/whatsapp';
import { classifyOrderConfirmReply } from '../../services/whatsappClassify';
import {
  cancelOrder,
  confirmOrder,
  isActionableStatus,
  listOpenOrdersForPhone,
} from '../../services/orderConfirm';

export const router = Router();

/**
 * POST /webhooks/whatsapp
 * Inbound WhatsApp messages for order confirmation (نعم / لا).
 */
router.post(
  '/whatsapp',
  asyncWrapper(async (req, res) => {
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const signature = req.header('x-wa-signature') || undefined;

    logger.info(
      {
        signature: signature ? `${signature.slice(0, 20)}…` : null,
        contentType: req.header('content-type'),
        rawLength: rawBody?.length ?? 0,
        body: req.body,
      },
      '[whatsapp webhook] received',
    );

    if (!verifyWebhookSignature(rawBody, signature)) {
      logger.warn('[whatsapp webhook] invalid signature — rejected');
      return res.status(401).json({ message: 'Invalid WhatsApp webhook signature' });
    }

    const event = req.body as {
      type?: string;
      body?: string;
      from?: string;
      session_id?: string;
      metadata?: { feature?: string; order_id?: string };
    };

    if (event.type !== 'message.inbound' && event.type !== 'message.unmatched') {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const feature = event.metadata?.feature;
    if (feature && feature !== 'order_confirm') {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const from = event.from ? normalizePhone(event.from) : '';
    const text = (event.body || '').trim();
    const sessionId = event.session_id || (await getOrderConfirmSessionId()) || '';

    const matchedOrderId = event.metadata?.order_id ? Number(event.metadata.order_id) : null;
    const openOrders = from ? await listOpenOrdersForPhone(from) : [];

    const classified = await classifyOrderConfirmReply({
      text,
      matchedOrderId:
        matchedOrderId && openOrders.some((o) => o.id === matchedOrderId)
          ? matchedOrderId
          : matchedOrderId && !Number.isNaN(matchedOrderId)
            ? matchedOrderId
            : null,
      openOrders,
    });

    logger.info(
      {
        from,
        text,
        matchedOrderId,
        openOrders: openOrders.map((o) => o.id),
        classified,
      },
      '[whatsapp webhook]',
    );

    if (
      classified.intent === 'unclear' ||
      classified.intent === 'which_order' ||
      !classified.orderId
    ) {
      if (sessionId && from) {
        await sendWhatsAppReply({
          sessionId,
          to: from,
          body: classified.replyToUser,
          orderId: classified.orderId ?? matchedOrderId ?? undefined,
        });
      }
      return res.status(200).json({
        ok: true,
        intent: classified.intent,
        order_id: classified.orderId,
      });
    }

    const orderRes = await pool.query(`SELECT * FROM orders WHERE id = $1`, [classified.orderId]);
    if (!orderRes.rowCount) {
      if (sessionId && from) {
        await sendWhatsAppReply({
          sessionId,
          to: from,
          body: `لم نجد الطلب #${classified.orderId}. تأكد من رقم الطلب.`,
        });
      }
      return res.status(200).json({ ok: true, message: 'order not found' });
    }

    const order = orderRes.rows[0];

    if (!isActionableStatus(order.status)) {
      if (sessionId && from) {
        await sendWhatsAppReply({
          sessionId,
          to: from,
          body:
            order.status === 'cancelled'
              ? `الطلب #${order.id} ملغي مسبقاً.`
              : `الطلب #${order.id} تمت معالجته مسبقاً (الحالة: ${order.status}).`,
          orderId: order.id,
        });
      }
      return res.status(200).json({
        ok: true,
        message: 'already handled',
        status: order.status,
      });
    }

    if (classified.intent === 'reject') {
      const result = await cancelOrder(order.id, 'whatsapp');
      if (sessionId && from) {
        await sendWhatsAppReply({
          sessionId,
          to: from,
          body: classified.replyToUser,
          orderId: order.id,
        });
      }
      return res.status(200).json({
        ok: true,
        intent: 'reject',
        status: result.status,
      });
    }

    const result = await confirmOrder(order.id, 'whatsapp');
    if (sessionId && from) {
      await sendWhatsAppReply({
        sessionId,
        to: from,
        body:
          result.message === 'awaiting_payment'
            ? `طلبك #${order.id} لسه مستني الدفع الإلكتروني. بعد الدفع هنتابع التأكيد.`
            : classified.replyToUser,
        orderId: order.id,
      });
    }

    return res.status(200).json({
      ok: true,
      intent: 'confirm',
      status: result.status,
    });
  }),
);
