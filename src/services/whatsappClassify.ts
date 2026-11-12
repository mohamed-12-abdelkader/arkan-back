import { config, logger } from '../utils';

export type ConfirmIntent = 'confirm' | 'reject' | 'which_order' | 'unclear';

export interface OpenOrderContext {
  id: number;
  totalAmount: number;
  status: string;
  order_number?: string;
}

export interface ClassifyResult {
  intent: ConfirmIntent;
  orderId: number | null;
  confidence: number;
  replyToUser: string;
}

const FALLBACK_UNCLEAR = 'عذراً، لم نفهم رسالتك. للتأكيد أرسل «نعم» مع رقم الطلب، أو «لا» للإلغاء.';

/**
 * Classify a WhatsApp reply about order confirmation using DeepSeek.
 * Falls back to simple rules if the API key is missing or the call fails.
 */
export async function classifyOrderConfirmReply(params: {
  text: string;
  matchedOrderId: number | null;
  openOrders: OpenOrderContext[];
}): Promise<ClassifyResult> {
  const { text, matchedOrderId, openOrders } = params;

  if (config.DEEPSEEK_API_KEY) {
    try {
      const llm = await callDeepSeek(text, matchedOrderId, openOrders);
      if (llm) return llm;
    } catch (err) {
      logger.error({ err }, '[deepseek] classify failed, using rules');
    }
  }

  return ruleBasedClassify(text, matchedOrderId, openOrders);
}

async function callDeepSeek(
  text: string,
  matchedOrderId: number | null,
  openOrders: OpenOrderContext[],
): Promise<ClassifyResult | null> {
  const ordersList =
    openOrders.length === 0
      ? '(none)'
      : openOrders
          .map(
            (o) =>
              `#${o.id} number=${o.order_number || o.id} amount=${o.totalAmount} status=${o.status}`,
          )
          .join('\n');

  const system = [
    'You are an Arabic/English WhatsApp assistant for an electronics store order confirmation flow (Arkan).',
    'Decide the user intent about confirming or cancelling an order.',
    'Respond ONLY with compact JSON:',
    '{"intent":"confirm"|"reject"|"which_order"|"unclear","order_id":number|null,"confidence":0-1,"reply_to_user":"arabic message to send back"}',
    'Rules:',
    '- If matched_order_id is set and user says yes/confirm vaguely, use that order_id with intent confirm.',
    '- If user says no/cancel vaguely, reject that matched order (or the only open one).',
    '- If multiple open orders and user does not specify which, intent=which_order and ask them to pick a number.',
    '- If user names an order id, use that order_id.',
    '- reply_to_user must be ONE short sentence in polite Saudi/Gulf-friendly Modern Standard Arabic (ack confirm/cancel). No follow-up questions. No Egyptian dialect.',
    '- When mentioning an order to the user, use its number= value (e.g. ARK-20261112-123456), never the internal #id.',
  ].join(' ');

  const user = [
    `matched_order_id: ${matchedOrderId ?? 'null'}`,
    `open_orders:\n${ordersList}`,
    `user_message: """${text}"""`,
  ].join('\n\n');

  const res = await fetch(`${config.DEEPSEEK_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.DEEPSEEK_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  const data = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  if (!res.ok) {
    throw new Error(`DeepSeek HTTP ${res.status}`);
  }

  const raw = data?.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw) as {
    intent?: string;
    order_id?: number | null;
    confidence?: number;
    reply_to_user?: string;
  };

  const intent = normalizeIntent(parsed.intent);
  const orderId =
    typeof parsed.order_id === 'number'
      ? parsed.order_id
      : (matchedOrderId ?? (openOrders.length === 1 ? openOrders[0].id : null));

  return {
    intent,
    orderId,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    replyToUser: parsed.reply_to_user?.trim() || defaultReply(intent, orderId, openOrders),
  };
}

function ruleBasedClassify(
  text: string,
  matchedOrderId: number | null,
  openOrders: OpenOrderContext[],
): ClassifyResult {
  const t = text.trim();
  const mentioned = t.match(/(?:#|طلب\s*|order\s*)?(\d{1,7})/i);
  const mentionedId = mentioned ? Number(mentioned[1]) : null;
  const validMention =
    mentionedId && openOrders.some((o) => o.id === mentionedId) ? mentionedId : null;

  const orderId =
    validMention ?? matchedOrderId ?? (openOrders.length === 1 ? openOrders[0].id : null);

  const isYes =
    /^(yes|y|ok|okay|confirm|نعم|ايوه|أيوه|موافق|تأكيد|تاكيد|أكد|اوك|أوك)\b/i.test(t) ||
    (/(نعم|موافق|confirm|yes)/i.test(t) && !/(لا|الغاء|إلغاء|cancel|رفض)/i.test(t));

  const isNo =
    /^(no|n|cancel|رفض|لا|الغاء|إلغاء|كنسل)\b/i.test(t) ||
    /(^لا\b|الغاء|إلغاء|cancel|رفض)/i.test(t);

  if (openOrders.length > 1 && !orderId && (isYes || isNo)) {
    return {
      intent: 'which_order',
      orderId: null,
      confidence: 0.7,
      replyToUser: defaultReply('which_order', null, openOrders),
    };
  }

  if (isYes && orderId) {
    return {
      intent: 'confirm',
      orderId,
      confidence: 0.75,
      replyToUser: defaultReply('confirm', orderId, openOrders),
    };
  }
  if (isNo && orderId) {
    return {
      intent: 'reject',
      orderId,
      confidence: 0.75,
      replyToUser: defaultReply('reject', orderId, openOrders),
    };
  }

  return {
    intent: 'unclear',
    orderId,
    confidence: 0.4,
    replyToUser: defaultReply('unclear', orderId, openOrders),
  };
}

function normalizeIntent(raw?: string): ConfirmIntent {
  switch ((raw || '').toLowerCase()) {
    case 'confirm':
    case 'reject':
    case 'which_order':
    case 'unclear':
      return raw!.toLowerCase() as ConfirmIntent;
    default:
      return 'unclear';
  }
}

function orderLabel(orderId: number, openOrders: OpenOrderContext[]) {
  const match = openOrders.find((o) => o.id === orderId);
  return match?.order_number || `#${orderId}`;
}

function defaultReply(
  intent: ConfirmIntent,
  orderId: number | null,
  openOrders: OpenOrderContext[],
): string {
  if (intent === 'confirm' && orderId) {
    return `تم تأكيد طلبك رقم ${orderLabel(orderId, openOrders)}، وسنبدأ تجهيزه الآن. شكراً لتسوقك من أركان.`;
  }
  if (intent === 'reject' && orderId) {
    return `تم إلغاء طلبك رقم ${orderLabel(orderId, openOrders)}.`;
  }
  if (intent === 'which_order') {
    const list = openOrders.map((o) => o.order_number || `#${o.id}`).join(' و ');
    return `لديك أكثر من طلب بانتظار التأكيد (${list}). أي طلب تقصد؟`;
  }
  if (orderId) {
    return `للتأكيد على الطلب ${orderLabel(orderId, openOrders)} أرسل «نعم»، وللإلغاء أرسل «لا».`;
  }
  return FALLBACK_UNCLEAR;
}
