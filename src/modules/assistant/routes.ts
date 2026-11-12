import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import pool from '../../db/pool';
import { asyncWrapper, HttpError } from '../../utils';
import { optionalAuth, authMiddleware, requirePermission } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { rateLimit } from '../../middleware/rateLimit';
import { ok } from '../../shared/response';
import {
  getAssistantConfig,
  runAssistantChat,
  saveAssistantConfig,
  trackAssistantEvent,
} from '../../services/assistant/chat';
import { clientKey } from '../../services/assistant/guards';
import { effectiveProductPrice } from '../../shared/money';
import { checkBuildCompatibility } from '../compatibility/engine';

export const router = Router();

const guestTokenSchema = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.string().uuid().nullable(),
);

router.get(
  '/config',
  asyncWrapper(async (_req, res) => {
    const cfg = await getAssistantConfig();
    ok(res, {
      enabled: cfg.enabled,
      welcome_message: cfg.welcome_message,
      quick_replies: cfg.quick_replies,
      max_message_length: cfg.max_message_length,
      message_cooldown_seconds: cfg.message_cooldown_seconds,
    });
  }),
);

/** Burst protection (IP) — hard ceiling regardless of admin config. */
const chatIpBurstLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  key: (req) => `assistant:chat:ip:${req.ip}`,
  message: 'طلبات كثيرة جداً من نفس الشبكة. حاول بعد دقيقة.',
});

/** New-conversation spam protection by IP (guest_token not yet issued). */
const chatIpDailyConversationLimiter = rateLimit({
  windowMs: 24 * 60 * 60_000,
  max: 40,
  key: (req) => `assistant:chat:ip-day:${req.ip}`,
  message: 'تم إنشاء محادثات كثيرة من نفس الشبكة اليوم. حاول لاحقاً.',
});

/** Identity-based minute limiter using admin config. */
const chatIdentityMinuteLimiter = asyncWrapper(async (req, res, next) => {
  const cfg = await getAssistantConfig();
  return rateLimit({
    windowMs: 60_000,
    max: cfg.rate_limit_per_minute,
    key: (r) => `assistant:chat:min:${clientKey(r)}`,
    message: `وصلت لحد الرسائل في الدقيقة (${cfg.rate_limit_per_minute}). استنى شوية وحاول تاني.`,
  })(req, res, next);
});

/** Identity-based hourly limiter using admin config. */
const chatIdentityHourLimiter = asyncWrapper(async (req, res, next) => {
  const cfg = await getAssistantConfig();
  return rateLimit({
    windowMs: 60 * 60_000,
    max: cfg.rate_limit_per_hour,
    key: (r) => `assistant:chat:hour:${clientKey(r)}`,
    message: `وصلت لحد الرسائل في الساعة (${cfg.rate_limit_per_hour}). حاول لاحقاً.`,
  })(req, res, next);
});

router.post(
  '/chat',
  optionalAuth(),
  chatIpBurstLimiter,
  chatIpDailyConversationLimiter,
  chatIdentityMinuteLimiter,
  chatIdentityHourLimiter,
  validate(
    z.object({
      message: z.string().min(1).max(4000),
      conversation_id: z.string().uuid().optional().nullable(),
      guest_token: guestTokenSchema,
    }),
  ),
  asyncWrapper(async (req, res) => {
    const result = await runAssistantChat({
      message: req.body.message,
      conversationId: req.body.conversation_id,
      guestToken: req.body.guest_token,
      userId: req.user?.id ?? null,
      ip: req.ip,
    });
    ok(res, result);
  }),
);

router.post(
  '/events',
  optionalAuth(),
  rateLimit({
    windowMs: 60_000,
    max: 60,
    key: (req) => `assistant:events:${clientKey(req)}`,
    message: 'تم تجاوز حد تتبع الأحداث. حاول لاحقاً.',
  }),
  validate(
    z.object({
      conversation_id: z.string().uuid().optional().nullable(),
      event_type: z.enum(['product_click', 'build_open', 'quick_reply', 'chat_open', 'new_chat']),
      meta: z.record(z.any()).optional(),
    }),
  ),
  asyncWrapper(async (req, res) => {
    await trackAssistantEvent({
      conversationId: req.body.conversation_id,
      eventType: req.body.event_type,
      meta: req.body.meta,
    });
    ok(res, { ok: true });
  }),
);

/**
 * Apply AI build plan into a real pc_build (safe handoff to /build)
 */
router.post(
  '/apply-build',
  optionalAuth(),
  rateLimit({
    windowMs: 60_000,
    max: 8,
    key: (req) => `assistant:apply:${clientKey(req)}`,
    message: 'محاولات كثيرة لفتح التجميعة. استنى دقيقة وحاول تاني.',
  }),
  rateLimit({
    windowMs: 60 * 60_000,
    max: 30,
    key: (req) => `assistant:apply:hour:${clientKey(req)}`,
    message: 'وصلت لحد فتح التجميعات في الساعة.',
  }),
  validate(
    z.object({
      guest_token: guestTokenSchema,
      conversation_id: z.string().uuid().optional().nullable(),
      components: z
        .array(
          z.object({
            slot_id: z.number().int().positive(),
            product_id: z.number().int().positive(),
            quantity: z.number().int().positive().max(5).default(1),
          }),
        )
        .min(1)
        .max(20),
    }),
  ),
  asyncWrapper(async (req, res) => {
    // Optional ownership check when conversation is provided
    if (req.body.conversation_id) {
      const conv = await pool.query(
        `SELECT id, user_id, guest_token FROM assistant_conversations WHERE id = $1`,
        [req.body.conversation_id],
      );
      if (!conv.rowCount) throw new HttpError(404, 'المحادثة غير موجودة');
      const row = conv.rows[0];
      if (req.user?.id && row.user_id && Number(row.user_id) !== Number(req.user.id)) {
        throw new HttpError(403, 'لا يمكن استخدام هذه المحادثة');
      }
      if (
        !req.user &&
        row.guest_token &&
        req.body.guest_token &&
        row.guest_token !== req.body.guest_token
      ) {
        throw new HttpError(403, 'لا يمكن استخدام هذه المحادثة');
      }
    }

    const guestToken = req.body.guest_token || cryptoRandom();
    const template = await pool.query(
      `SELECT id FROM build_templates WHERE slug = 'custom-pc' AND is_active = TRUE LIMIT 1`,
    );
    if (!template.rowCount) throw new HttpError(404, 'Build template not found');

    const build = await pool.query(
      `INSERT INTO pc_builds (user_id, guest_token, template_id, name, share_token)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        req.user?.id ?? null,
        req.user ? null : guestToken,
        template.rows[0].id,
        'تجميعة مساعد أركان',
        randomHex(16),
      ],
    );

    let inserted = 0;
    for (const item of req.body.components) {
      const product = await pool.query(
        `SELECT * FROM products WHERE id = $1 AND status = 'active' AND is_active = TRUE`,
        [item.product_id],
      );
      if (!product.rowCount) continue;
      const unit = effectiveProductPrice(product.rows[0]);
      await pool.query(
        `INSERT INTO pc_build_items (build_id, slot_id, product_id, quantity, unit_price)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (build_id, slot_id, product_id, variant_id)
         DO UPDATE SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price`,
        [build.rows[0].id, item.slot_id, item.product_id, item.quantity || 1, unit],
      );
      inserted += 1;
    }
    if (!inserted) throw new HttpError(400, 'لا توجد مكونات صالحة لتطبيق التجميعة');

    const items = await pool.query(
      `SELECT bi.*, p.component_type, p.specs, p.name, p.price, p.sale_price, p.sale_starts_at, p.sale_ends_at
       FROM pc_build_items bi
       JOIN products p ON p.id = bi.product_id
       WHERE bi.build_id = $1`,
      [build.rows[0].id],
    );
    const compat = await checkBuildCompatibility(items.rows);

    if (req.body.conversation_id) {
      await trackAssistantEvent({
        conversationId: req.body.conversation_id,
        eventType: 'build_open',
        meta: { build_id: build.rows[0].id },
      });
    }

    ok(res, {
      build_id: build.rows[0].id,
      guest_token: build.rows[0].guest_token || guestToken,
      compatibility: compat,
      href: `/build?build_id=${build.rows[0].id}`,
    });
  }),
);

router.get(
  '/admin/config',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  asyncWrapper(async (_req, res) => {
    ok(res, await getAssistantConfig());
  }),
);

router.put(
  '/admin/config',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  validate(
    z.object({
      enabled: z.boolean().optional(),
      welcome_message: z.string().min(3).max(1000).optional(),
      persona: z.string().min(3).max(1000).optional(),
      sales_instructions: z.string().min(3).max(3000).optional(),
      allow_upsell: z.boolean().optional(),
      allow_cross_sell: z.boolean().optional(),
      quick_replies: z.array(z.string().min(1).max(80)).max(8).optional(),
      rate_limit_per_minute: z.number().int().min(1).max(60).optional(),
      rate_limit_per_hour: z.number().int().min(5).max(500).optional(),
      max_messages_per_conversation: z.number().int().min(5).max(200).optional(),
      max_messages_per_day: z.number().int().min(10).max(1000).optional(),
      max_conversations_per_day: z.number().int().min(1).max(100).optional(),
      max_message_length: z.number().int().min(100).max(4000).optional(),
      message_cooldown_seconds: z.number().int().min(0).max(30).optional(),
    }),
  ),
  asyncWrapper(async (req, res) => {
    ok(res, await saveAssistantConfig(req.body));
  }),
);

router.get(
  '/admin/stats',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  asyncWrapper(async (_req, res) => {
    const [conversations, messages, events, topEvents] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM assistant_conversations`),
      pool.query(`SELECT COUNT(*)::int AS c FROM assistant_messages`),
      pool.query(`SELECT COUNT(*)::int AS c FROM assistant_events`),
      pool.query(
        `SELECT event_type, COUNT(*)::int AS count
         FROM assistant_events
         GROUP BY event_type
         ORDER BY count DESC`,
      ),
    ]);
    ok(res, {
      conversations: conversations.rows[0].c,
      messages: messages.rows[0].c,
      events: events.rows[0].c,
      by_event: topEvents.rows,
    });
  }),
);

router.get(
  '/admin/conversations',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  asyncWrapper(async (req, res) => {
    const limit = Math.min(Number(req.query.limit || 30), 100);
    const rows = await pool.query(
      `SELECT c.id, c.guest_token, c.user_id, c.created_at, c.updated_at,
              (SELECT content FROM assistant_messages m
               WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
              (SELECT COUNT(*)::int FROM assistant_messages m WHERE m.conversation_id = c.id) AS messages_count
       FROM assistant_conversations c
       ORDER BY c.updated_at DESC
       LIMIT $1`,
      [limit],
    );
    ok(res, rows.rows);
  }),
);

function cryptoRandom() {
  return crypto.randomUUID();
}
function randomHex(bytes: number) {
  return crypto.randomBytes(bytes).toString('hex');
}
