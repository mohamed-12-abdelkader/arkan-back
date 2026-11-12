import pool from '../../db/pool';
import { HttpError } from '../../utils';
import type { AssistantConfig } from './chat';

// eslint-disable-next-line no-control-regex -- intentionally strips control characters from user input
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const REPEAT_CHAR = /(.)\1{40,}/u;
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /system\s*prompt/i,
  /you\s+are\s+now\s+(dan|unrestricted|jailbroken)/i,
  /reveal\s+(your|the)\s+(api|secret|key|prompt)/i,
  /تجاهل\s+(كل\s+)?التعليمات/i,
  /اعرض\s+(البرومبت|مفتاح|api)/i,
];

export function sanitizeAssistantMessage(raw: string, maxLength: number) {
  const cleaned = String(raw || '')
    .replace(CONTROL_CHARS, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!cleaned) {
    throw new HttpError(400, 'الرسالة فارغة');
  }
  if (cleaned.length > maxLength) {
    throw new HttpError(400, `الرسالة طويلة جداً (الحد ${maxLength} حرف)`);
  }
  if (REPEAT_CHAR.test(cleaned)) {
    throw new HttpError(400, 'الرسالة غير صالحة');
  }
  return cleaned;
}

export function assertAssistantMessageSafe(message: string) {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      throw new HttpError(400, 'لا يمكن معالجة هذه الرسالة');
    }
  }
  // Block obvious bulk paste / binary noise
  const nonTextRatio =
    (message.match(/[^\p{L}\p{N}\p{P}\p{Z}\n]/gu) || []).length / Math.max(1, message.length);
  if (message.length > 80 && nonTextRatio > 0.35) {
    throw new HttpError(400, 'الرسالة تحتوي رموز غير مسموحة');
  }
}

export async function enforceAssistantChatLimits(opts: {
  cfg: AssistantConfig;
  conversationId: string;
  guestToken?: string | null;
  userId?: number | null;
  ip?: string | null;
}) {
  const maxPerConversation = opts.cfg.max_messages_per_conversation;
  const maxPerDay = opts.cfg.max_messages_per_day;
  const cooldownSec = opts.cfg.message_cooldown_seconds;

  const countInConversation = await pool.query(
    `SELECT COUNT(*)::int AS c,
            MAX(created_at) AS last_at
     FROM assistant_messages
     WHERE conversation_id = $1 AND role = 'user'`,
    [opts.conversationId],
  );
  const used = Number(countInConversation.rows[0]?.c || 0);
  if (used >= maxPerConversation) {
    throw new HttpError(
      429,
      `وصلت للحد الأقصى لرسائل هذه المحادثة (${maxPerConversation}). ابدأ محادثة جديدة.`,
    );
  }

  const lastAt = countInConversation.rows[0]?.last_at
    ? new Date(countInConversation.rows[0].last_at).getTime()
    : 0;
  if (cooldownSec > 0 && lastAt > 0) {
    const waitMs = cooldownSec * 1000 - (Date.now() - lastAt);
    if (waitMs > 0) {
      throw new HttpError(429, `استنى ${Math.ceil(waitMs / 1000)} ثانية قبل إرسال رسالة جديدة`);
    }
  }

  // Daily cap by authenticated user or guest token (fallback: conversation only)
  const identityClause = opts.userId
    ? `c.user_id = $1`
    : opts.guestToken
      ? `c.guest_token = $1`
      : `c.id = $1`;
  const identityValue = opts.userId ? opts.userId : opts.guestToken || opts.conversationId;

  const daily = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM assistant_messages m
     JOIN assistant_conversations c ON c.id = m.conversation_id
     WHERE m.role = 'user'
       AND m.created_at >= NOW() - INTERVAL '1 day'
       AND ${identityClause}`,
    [identityValue],
  );
  if (Number(daily.rows[0]?.c || 0) >= maxPerDay) {
    throw new HttpError(429, `وصلت للحد اليومي لاستخدام المساعد (${maxPerDay} رسالة). حاول بكرة.`);
  }

  // Cap how many new conversations a guest/user can open per day
  const maxConversations = opts.cfg.max_conversations_per_day;
  const convDaily = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM assistant_conversations c
     WHERE c.created_at >= NOW() - INTERVAL '1 day'
       AND ${identityClause}`,
    [identityValue],
  );
  // Only enforce when creating brand-new conversations is already done;
  // here we just expose helper for ensureConversation path via separate check.
  return {
    messages_used: used,
    messages_remaining: Math.max(0, maxPerConversation - used),
    daily_used: Number(daily.rows[0]?.c || 0),
    daily_remaining: Math.max(0, maxPerDay - Number(daily.rows[0]?.c || 0)),
    conversations_today: Number(convDaily.rows[0]?.c || 0),
    max_conversations_per_day: maxConversations,
  };
}

export async function assertCanCreateConversation(opts: {
  cfg: AssistantConfig;
  guestToken?: string | null;
  userId?: number | null;
}) {
  // Without identity we rely on IP rate-limit middleware; still block extreme open creation via guest-less spam later.
  if (!opts.userId && !opts.guestToken) return;
  const identityClause = opts.userId ? `user_id = $1` : `guest_token = $1`;
  const identityValue = opts.userId ?? opts.guestToken;
  const rows = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM assistant_conversations
     WHERE created_at >= NOW() - INTERVAL '1 day'
       AND ${identityClause}`,
    [identityValue],
  );
  if (Number(rows.rows[0]?.c || 0) >= opts.cfg.max_conversations_per_day) {
    throw new HttpError(
      429,
      `وصلت لحد المحادثات اليومية (${opts.cfg.max_conversations_per_day}). كمّل على محادثة موجودة أو حاول لاحقاً.`,
    );
  }
}

export function clientKey(req: { ip?: string; body?: any; user?: { id?: number } | null }) {
  const userId = req.user?.id;
  const guest = typeof req.body?.guest_token === 'string' ? req.body.guest_token : '';
  if (userId) return `user:${userId}`;
  if (guest) return `guest:${guest.slice(0, 64)}`;
  return `ip:${req.ip || 'unknown'}`;
}
