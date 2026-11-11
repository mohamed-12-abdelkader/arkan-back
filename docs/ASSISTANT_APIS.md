# AI Sales Assistant APIs

مساعد مبيعات أركان يعتمد على DeepSeek مع Tool Calling، والبيانات والأسعار والتوافق من قاعدة البيانات فقط.

## Public

### `GET /assistant/config`
إعدادات الواجهة العامة: `enabled`, `welcome_message`, `quick_replies`.

### `POST /assistant/chat`
Body:
```json
{
  "message": "عايز تفاصيل RTX 4060",
  "conversation_id": "uuid|null",
  "guest_token": "string|null"
}
```
Response: رسالة المساعد + `products[]` + اختياري `build_plan` + `conversation_id` + `limits`.

### الحماية وحدود الاستخدام
- Rate limit طبقي: IP burst (20/دقيقة) + حد بالدقيقة/الساعة حسب هوية المستخدم أو الضيف (قابل للضبط من الأدمن).
- حد رسائل لكل محادثة + حد يومي + حد محادثات يومية + تهدئة بين الرسائل.
- تنظيف الرسالة ومنع محاولات injection/spam.
- التحقق من ملكية المحادثة عبر `guest_token` أو المستخدم المسجّل.
- `Retry-After` ورسائل عربية عند `429`.

القيم الافتراضية: 8 رسائل/دقيقة، 40/ساعة، 40/محادثة، 80/يوم، 12 محادثة/يوم، طول 1000، تهدئة 2ث.

### `POST /assistant/events`
تتبع: `product_click`, `build_open`, `quick_reply`, `chat_open`, `new_chat`.  
Rate limit: 60/دقيقة لكل هوية.

### `POST /assistant/apply-build`
ينشئ `pc_builds` حقيقية من مكونات مقترحة ثم يعيد:
```json
{ "build_id": 12, "guest_token": "...", "href": "/build?build_id=12" }
```
الواجهة تفتح `/build?build_id=` وتحمّل المكونات عبر النظام الحالي.  
Rate limit: 8/دقيقة و 30/ساعة لكل هوية + تحقق ملكية المحادثة.

## Admin (requires `settings.manage`)

- `GET /assistant/admin/config`
- `PUT /assistant/admin/config` (يشمل حدود الاستخدام)
- `GET /assistant/admin/stats`
- `GET /assistant/admin/conversations`

## Tools المتاحة للنموذج

- `search_products`
- `get_product_details`
- `compare_products`
- `get_categories`
- `recommend_build`
- `get_store_policies`

المفتاح `DEEPSEEK_API_KEY` يبقى في Backend فقط.
