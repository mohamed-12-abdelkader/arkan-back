-- Up Migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS assistant_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  guest_token TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assistant_conversations_guest ON assistant_conversations (guest_token);
CREATE INDEX IF NOT EXISTS idx_assistant_conversations_user ON assistant_conversations (user_id);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES assistant_conversations (id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_conversation ON assistant_messages (conversation_id);

CREATE TABLE IF NOT EXISTS assistant_events (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID REFERENCES assistant_conversations (id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assistant_events_type ON assistant_events (event_type);

INSERT INTO store_settings (key, value) VALUES
  ('assistant_config', '{
    "enabled": true,
    "welcome_message": "أهلاً بيك! أنا مساعدك الشخصي في أركان، موجود علشان أساعدك تختار المنتج المناسب ليك بأفضل قيمة مقابل ميزانيتك. تحب أساعدك في إيه؟",
    "persona": "مندوب مبيعات محترف وودود يتكلم عربي عامية مصرية مختصرة، متخصص في أجهزة الكمبيوتر والتجميعات.",
    "sales_instructions": "ساعد العميل يختار حسب ميزانيته واستخدامه. لا تخترع منتجات أو أسعار. اقترح بدائل حقيقية فقط من قاعدة البيانات. للتجميعات اسأل تدريجياً عن الميزانية والاستخدام ثم رشّح مكونات متوافقة.",
    "allow_upsell": true,
    "allow_cross_sell": true,
    "quick_replies": [
      "عايز أعرف تفاصيل منتج",
      "ساعدني أختار منتج مناسب",
      "عايز أعمل تجميعة",
      "عايز أعرف أنسب حاجة لميزانيتي"
    ]
  }'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Down Migration
-- DROP TABLE IF EXISTS assistant_events, assistant_messages, assistant_conversations;
-- DELETE FROM store_settings WHERE key = 'assistant_config';
