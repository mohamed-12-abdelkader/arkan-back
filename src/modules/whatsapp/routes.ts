import { Router } from 'express';
import { z } from 'zod';
import { asyncWrapper, HttpError } from '../../utils';
import { authMiddleware, requirePermission } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { ok, created } from '../../shared/response';
import {
  createSession,
  deleteSession,
  getOrderConfirmSessionId,
  getSession,
  isWhatsAppConfigured,
  listSessions,
  maybeNotifyOrderWhatsApp,
  reconnectSession,
  setOrderConfirmSessionId,
} from '../../services/whatsapp';

export const router = Router();

/** Same payload shape as glassShop (+ snake_case aliases for Arkan frontend). */
function statusPayload(sessionId: string | null) {
  return {
    configured: isWhatsAppConfigured(),
    // glassShop
    orderConfirmSessionId: sessionId,
    // Arkan frontend
    order_confirm_session_id: sessionId,
  };
}

router.get(
  '/status',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  asyncWrapper(async (_req, res) => {
    ok(res, statusPayload(await getOrderConfirmSessionId()));
  }),
);

router.get(
  '/sessions',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  asyncWrapper(async (_req, res) => {
    if (!isWhatsAppConfigured()) {
      throw new HttpError(503, 'WhatsApp gateway is not configured (WHATSAPP_API_KEY).');
    }
    const sessions = await listSessions();
    const orderConfirmSessionId = await getOrderConfirmSessionId();
    ok(res, {
      sessions,
      orderConfirmSessionId,
      order_confirm_session_id: orderConfirmSessionId,
    });
  }),
);

router.post(
  '/sessions',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  validate(z.object({ id: z.string().min(2).max(80) })),
  asyncWrapper(async (req, res) => {
    if (!isWhatsAppConfigured()) {
      throw new HttpError(503, 'WhatsApp gateway is not configured.');
    }
    const session = await createSession(req.body.id);
    created(res, session);
  }),
);

router.get(
  '/sessions/:id',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  asyncWrapper(async (req, res) => {
    if (!isWhatsAppConfigured()) {
      throw new HttpError(503, 'WhatsApp gateway is not configured.');
    }
    ok(res, await getSession(req.params.id));
  }),
);

router.post(
  '/sessions/:id/reconnect',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  asyncWrapper(async (req, res) => {
    if (!isWhatsAppConfigured()) {
      throw new HttpError(503, 'WhatsApp gateway is not configured.');
    }
    ok(res, await reconnectSession(req.params.id));
  }),
);

router.delete(
  '/sessions/:id',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  asyncWrapper(async (req, res) => {
    if (!isWhatsAppConfigured()) {
      throw new HttpError(503, 'WhatsApp gateway is not configured.');
    }
    try {
      await deleteSession(req.params.id);
    } catch (err: any) {
      throw new HttpError(err?.status || 502, err?.message || 'Failed to delete WhatsApp session');
    }
    const assigned = await getOrderConfirmSessionId();
    if (assigned === req.params.id) {
      await setOrderConfirmSessionId(null);
    }
    ok(res, { ok: true });
  }),
);

/**
 * PUT /whatsapp/settings
 * Accepts glassShop body { orderConfirmSessionId } or Arkan { order_confirm_session_id }
 */
router.put(
  '/settings',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  validate(
    z
      .object({
        orderConfirmSessionId: z.string().min(1).nullable().optional(),
        order_confirm_session_id: z.string().min(1).nullable().optional(),
      })
      .refine(
        (b) => b.orderConfirmSessionId !== undefined || b.order_confirm_session_id !== undefined,
        { message: 'orderConfirmSessionId is required' },
      ),
  ),
  asyncWrapper(async (req, res) => {
    const sessionId =
      req.body.orderConfirmSessionId !== undefined
        ? req.body.orderConfirmSessionId
        : req.body.order_confirm_session_id;

    if (sessionId) {
      if (isWhatsAppConfigured()) {
        try {
          await getSession(sessionId);
        } catch {
          throw new HttpError(404, 'Session not found');
        }
      }
      await setOrderConfirmSessionId(sessionId);
    } else {
      await setOrderConfirmSessionId(null);
    }

    ok(res, statusPayload(await getOrderConfirmSessionId()));
  }),
);

/** Admin: re-send confirmation WhatsApp for an order (glassShop behavior). */
router.post(
  '/orders/:id/resend-confirm',
  authMiddleware(['admin']),
  requirePermission('orders.manage'),
  asyncWrapper(async (req, res) => {
    const result = await maybeNotifyOrderWhatsApp(Number(req.params.id));
    if (!result.ok) {
      throw new HttpError(400, `تعذر إرسال رسالة التأكيد (${result.reason})`);
    }
    ok(res, result);
  }),
);
