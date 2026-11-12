import crypto from 'node:crypto';
import pool from '../../db/pool';
import { config, HttpError, logger } from '../../utils';
import {
  assertAssistantMessageSafe,
  assertCanCreateConversation,
  enforceAssistantChatLimits,
  sanitizeAssistantMessage,
} from './guards';
import { assistantToolDefinitions, runAssistantTool, type AssistantProductCard } from './tools';

export type AssistantConfig = {
  enabled: boolean;
  welcome_message: string;
  persona: string;
  sales_instructions: string;
  allow_upsell: boolean;
  allow_cross_sell: boolean;
  quick_replies: string[];
  /** Soft rate limits (also enforced in routes via middleware). */
  rate_limit_per_minute: number;
  rate_limit_per_hour: number;
  max_messages_per_conversation: number;
  max_messages_per_day: number;
  max_conversations_per_day: number;
  max_message_length: number;
  message_cooldown_seconds: number;
};

const DEFAULT_CONFIG: AssistantConfig = {
  enabled: true,
  welcome_message:
    'أهلاً وسهلاً! أنا مساعدك في أركان، أساعدك تختار المنتج المناسب لك بأفضل قيمة حسب ميزانيتك. وش تحتاج اليوم؟',
  persona:
    'مندوب مبيعات محترف وودود يتكلم بلهجة سعودية بيضاء مختصرة ومهذبة (بدون لهجة مصرية)، متخصص في أجهزة الكمبيوتر والتجميعات، والأسعار بالريال السعودي.',
  sales_instructions:
    'ساعد العميل يختار حسب ميزانيته واستخدامه. لا تخترع منتجات أو أسعار. اقترح بدائل حقيقية فقط من قاعدة البيانات. للتجميعات اسأل تدريجياً عن الميزانية والاستخدام ثم رشّح مكونات متوافقة.',
  allow_upsell: true,
  allow_cross_sell: true,
  quick_replies: [
    'أبغى أعرف تفاصيل منتج',
    'ساعدني أختار منتج مناسب',
    'أبغى أسوي تجميعة',
    'وش أنسب شي لميزانيتي؟',
  ],
  rate_limit_per_minute: 8,
  rate_limit_per_hour: 40,
  max_messages_per_conversation: 40,
  max_messages_per_day: 80,
  max_conversations_per_day: 12,
  max_message_length: 1000,
  message_cooldown_seconds: 2,
};

function normalizeLimits(raw: Partial<AssistantConfig>): AssistantConfig {
  const merged = { ...DEFAULT_CONFIG, ...raw };
  const clamp = (n: unknown, min: number, max: number, fallback: number) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(v)));
  };
  return {
    ...merged,
    rate_limit_per_minute: clamp(merged.rate_limit_per_minute, 1, 60, 8),
    rate_limit_per_hour: clamp(merged.rate_limit_per_hour, 5, 500, 40),
    max_messages_per_conversation: clamp(merged.max_messages_per_conversation, 5, 200, 40),
    max_messages_per_day: clamp(merged.max_messages_per_day, 10, 1000, 80),
    max_conversations_per_day: clamp(merged.max_conversations_per_day, 1, 100, 12),
    max_message_length: clamp(merged.max_message_length, 100, 4000, 1000),
    message_cooldown_seconds: clamp(merged.message_cooldown_seconds, 0, 30, 2),
  };
}

export async function getAssistantConfig(): Promise<AssistantConfig> {
  const result = await pool.query(
    `SELECT value FROM store_settings WHERE key = 'assistant_config' LIMIT 1`,
  );
  if (!result.rowCount) return DEFAULT_CONFIG;
  return normalizeLimits({ ...DEFAULT_CONFIG, ...(result.rows[0].value || {}) });
}

export async function saveAssistantConfig(patch: Partial<AssistantConfig>) {
  const current = await getAssistantConfig();
  const next = normalizeLimits({ ...current, ...patch });
  await pool.query(
    `INSERT INTO store_settings (key, value, updated_at)
     VALUES ('assistant_config', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(next)],
  );
  return next;
}

async function ensureConversation(opts: {
  conversationId?: string | null;
  guestToken?: string | null;
  userId?: number | null;
  cfg: AssistantConfig;
}) {
  if (opts.conversationId) {
    const existing = await pool.query(`SELECT * FROM assistant_conversations WHERE id = $1`, [
      opts.conversationId,
    ]);
    if (existing.rowCount) {
      const row = existing.rows[0];
      // Ownership: logged-in user or matching guest token
      if (opts.userId && row.user_id && Number(row.user_id) !== Number(opts.userId)) {
        throw new HttpError(403, 'لا يمكن الوصول لهذه المحادثة');
      }
      if (
        !opts.userId &&
        row.guest_token &&
        opts.guestToken &&
        row.guest_token !== opts.guestToken
      ) {
        throw new HttpError(403, 'لا يمكن الوصول لهذه المحادثة');
      }
      if (!opts.userId && row.guest_token && !opts.guestToken) {
        throw new HttpError(403, 'جلسة المحادثة غير صالحة');
      }
      return row;
    }
  }

  await assertCanCreateConversation({
    cfg: opts.cfg,
    guestToken: opts.guestToken,
    userId: opts.userId,
  });

  const created = await pool.query(
    `INSERT INTO assistant_conversations (user_id, guest_token, context)
     VALUES ($1, $2, '{}'::jsonb)
     RETURNING *`,
    [opts.userId ?? null, opts.guestToken || crypto.randomUUID()],
  );
  return created.rows[0];
}

async function loadHistory(conversationId: string, limit = 20) {
  const rows = await pool.query(
    `SELECT role, content FROM assistant_messages
     WHERE conversation_id = $1
     ORDER BY id DESC
     LIMIT $2`,
    [conversationId, limit],
  );
  return rows.rows.reverse();
}

function systemPrompt(cfg: AssistantConfig) {
  return `أنت مساعد مبيعات ذكي لمتجر أركان (Arkan PC Store).
الشخصية: ${cfg.persona}
تعليمات البيع: ${cfg.sales_instructions}
السماح بالاقتراح الأعلى سعراً (upsell): ${cfg.allow_upsell ? 'نعم' : 'لا'}
السماح بالمنتجات المكملة (cross-sell): ${cfg.allow_cross_sell ? 'نعم' : 'لا'}

قواعد صارمة:
1) لا تخترع منتجات أو أسعار أو مخزون. استخدم الأدوات فقط.
2) روابط المنتجات يجب أن تأتي من نتائج الأدوات.
3) للتجميعات: اسأل تدريجياً عن الميزانية والاستخدام، ثم استدعِ recommend_build.
4) الردود عربية مختصرة ومنظمة، بدون فقرات طويلة جداً.
5) عند عرض منتجات، اذكر الاسم والسعر الحقيقي فقط من الأدوات.
6) إذا لم تجد نتائج، قل ذلك بوضوح واقترح بدائل عبر البحث.`;
}

type DeepSeekMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
};

async function callDeepSeek(messages: DeepSeekMessage[]) {
  if (!config.DEEPSEEK_API_KEY) {
    throw new HttpError(500, 'مساعد الذكاء غير مفعّل: DEEPSEEK_API_KEY غير موجود');
  }

  const res = await fetch(`${config.DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.DEEPSEEK_MODEL,
      messages,
      tools: assistantToolDefinitions,
      tool_choice: 'auto',
      temperature: 0.4,
    }),
  });

  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    logger.error({ status: res.status, json }, 'DeepSeek error');
    throw new HttpError(502, 'تعذر الاتصال بمساعد الذكاء حالياً');
  }
  return json;
}

export async function runAssistantChat(input: {
  message: string;
  conversationId?: string | null;
  guestToken?: string | null;
  userId?: number | null;
  ip?: string | null;
}) {
  const cfg = await getAssistantConfig();
  if (!cfg.enabled) {
    throw new HttpError(503, 'المساعد متوقف حالياً من لوحة التحكم');
  }

  const safeMessage = sanitizeAssistantMessage(input.message, cfg.max_message_length);
  assertAssistantMessageSafe(safeMessage);

  const conversation = await ensureConversation({
    conversationId: input.conversationId,
    guestToken: input.guestToken,
    userId: input.userId,
    cfg,
  });

  const limits = await enforceAssistantChatLimits({
    cfg,
    conversationId: conversation.id,
    guestToken: conversation.guest_token || input.guestToken,
    userId: input.userId,
    ip: input.ip,
  });

  await pool.query(
    `INSERT INTO assistant_messages (conversation_id, role, content)
     VALUES ($1, 'user', $2)`,
    [conversation.id, safeMessage],
  );

  const history = await loadHistory(conversation.id, 16);
  const messages: DeepSeekMessage[] = [
    { role: 'system', content: systemPrompt(cfg) },
    ...history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  const productCards: AssistantProductCard[] = [];
  let buildPlan: any = null;
  let finalText = '';

  // Tool loop (max 4 rounds)
  for (let round = 0; round < 4; round++) {
    const completion = await callDeepSeek(messages);
    const choice = completion?.choices?.[0]?.message;
    if (!choice) throw new HttpError(502, 'رد غير صالح من المساعد');

    const toolCalls = choice.tool_calls || [];
    if (!toolCalls.length) {
      finalText = String(choice.content || '').trim();
      break;
    }

    messages.push({
      role: 'assistant',
      content: choice.content || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const name = call.function?.name as string;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }
      const toolOut = await runAssistantTool(name, args);
      if (toolOut.cards?.length) productCards.push(...toolOut.cards);
      if (toolOut.buildPlan) buildPlan = toolOut.buildPlan;

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(toolOut.result),
      });
    }
  }

  if (!finalText) {
    // one last non-tool attempt if loop ended on tools only
    const completion = await callDeepSeek(
      messages.concat([
        {
          role: 'system',
          content: 'لخّص النتيجة للعميل الآن بدون استدعاء أدوات إضافية.',
        },
      ]),
    );
    finalText = String(completion?.choices?.[0]?.message?.content || '').trim();
  }

  if (!finalText) {
    finalText = buildPlan
      ? 'دي أفضل تجميعة لقيتُها حسب طلبك. تقدر تفتحها وتعدّل أي قطعة.'
      : productCards.length
        ? 'لقيت لك الخيارات دي من منتجاتنا الحالية.'
        : 'ممكن توضّح أكتر ميزانيتك أو نوع الاستخدام عشان أرشح لك بدقة؟';
  }

  // Dedupe cards by id
  const uniqueCards = [...new Map(productCards.map((c) => [c.id, c])).values()].slice(0, 8);
  const payload = {
    products: uniqueCards,
    build_plan: buildPlan,
    actions: buildPlan
      ? [{ type: 'open_build', label: 'اعرض التجميعة وخصص مكوناتها' }]
      : uniqueCards.map((p) => ({
          type: 'open_product',
          label: 'عرض المنتج',
          product_id: p.id,
          href: p.href,
        })),
  };

  const saved = await pool.query(
    `INSERT INTO assistant_messages (conversation_id, role, content, payload)
     VALUES ($1, 'assistant', $2, $3::jsonb)
     RETURNING id, created_at`,
    [conversation.id, finalText, JSON.stringify(payload)],
  );

  await pool.query(
    `UPDATE assistant_conversations SET updated_at = NOW(), context = COALESCE(context, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [
      conversation.id,
      JSON.stringify({
        last_budget: buildPlan?.budget ?? undefined,
        last_usage: buildPlan?.usage ?? undefined,
      }),
    ],
  );

  return {
    conversation_id: conversation.id,
    guest_token: conversation.guest_token,
    limits: {
      messages_remaining: Math.max(0, limits.messages_remaining - 1),
      daily_remaining: Math.max(0, limits.daily_remaining - 1),
      max_messages_per_conversation: cfg.max_messages_per_conversation,
      max_messages_per_day: cfg.max_messages_per_day,
    },
    message: {
      id: String(saved.rows[0].id),
      role: 'assistant' as const,
      text: finalText,
      created_at: saved.rows[0].created_at,
      products: uniqueCards,
      build_plan: buildPlan,
      actions: payload.actions,
    },
  };
}

export async function trackAssistantEvent(input: {
  conversationId?: string | null;
  eventType: string;
  meta?: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO assistant_events (conversation_id, event_type, meta)
     VALUES ($1, $2, $3::jsonb)`,
    [input.conversationId || null, input.eventType, JSON.stringify(input.meta || {})],
  );
}
