# دليل تنفيذ واجهة واتساب (Frontend)

هذا المستند مخصص لفريق الفرونت لبناء واجهات **إدارة واتساب** و**متابعة تأكيد الطلبات**.  
الـ Backend جاهز ويعمل على:

```text
BASE = {NEXT_PUBLIC_API_BASE_URL}   // مثال: http://localhost:8000/api/v1
```

كل ردود الـ API بشكل:

```json
{ "success": true, "data": { ... } }
```

أو عند الخطأ:

```json
{ "success": false, "message": "..." }
```

أرسل التوكن هكذا:

```http
Authorization: Bearer {accessToken}
Content-Type: application/json
```

الصلاحيات:

| Endpoint | Permission |
|----------|------------|
| معظم `/whatsapp/*` | أدمن + `settings.manage` (أو role=`admin`) |
| `POST /whatsapp/orders/:id/resend-confirm` | أدمن + `orders.manage` |

---

## 1) الفكرة العامة للمنتج

نفس سلوك **جفون / glassShop**:

1. الطلب يُنشأ `pending` (أو بعد دفع Paymob يبقى `pending`)
2. Backend يرسل رسالة واتساب فيها ملخص الطلب
3. **فقط عند نجاح الإرسال** تصبح الحالة `awaiting_confirmation`
4. لو فشل الإرسال يبقى `pending` للتأكيد اليدوي
5. العميل يرد: **نعم** أو **لا**
6. Webhook يحدّث الحالة إلى:
   - `confirmed` عند التأكيد
   - `cancelled` عند الإلغاء

الفرونت **لا** يستدعي الـ webhook.  
الفرونت فقط:

- يجهّز الجلسة (QR) من لوحة الأدمن
- يعرض حالة الطلب للعميل/الأدمن
- يتيح إعادة إرسال رسالة التأكيد من صفحة الطلب

---

## 2) حالات الطلب المهمة للواجهة

استخدم هذه الترجمة في UI:

| `status` | عرض عربي مقترح | ملاحظات UI |
|----------|-----------------|------------|
| `pending_payment` | بانتظار الدفع | Paymob فقط |
| `awaiting_confirmation` | بانتظار تأكيد واتساب | أظهر badge “واتساب” + زر إعادة إرسال للأدمن |
| `confirmed` | تم التأكيد | بعد رد العميل بنعم أو تأكيد يدوي |
| `processing` | قيد التجهيز | |
| `ready_for_shipment` | جاهز للشحن | |
| `shipped` | تم الشحن | |
| `delivered` | تم التسليم | |
| `cancelled` | ملغي | بعد رد لا أو إلغاء إداري |

ألوان مقترحة:

- `awaiting_confirmation` → أصفر/تحذير
- `confirmed` → أخضر
- `cancelled` → أحمر
- `pending_payment` → أزرق

---

## 3) شاشات الفرونت المطلوبة

### A) لوحة الأدمن: إعداد واتساب

المسار المقترح: `/admin/whatsapp`  
(موجود بالفعل في المشروع الحالي كنقطة بداية)

#### مكونات الشاشة

1. **بطاقة الحالة**
   - البوابة مُعدّة؟ `configured`
   - الجلسة المعينة لتأكيد الطلبات: `order_confirm_session_id`

2. **إنشاء جلسة**
   - Input لـ `id` (مثل `arkan-orders`)
   - زر إنشاء

3. **قائمة الجلسات**
   - لكل جلسة: id / status / أزرار: عرض، تعيين، إعادة اتصال، حذف

4. **لوحة QR**
   - عند اختيار جلسة: اعرض QR لمسح واتساب من الموبايل
   - زر “تحديث QR”
   - Polling كل 3–5 ثوانٍ أثناء انتظار المسح حتى تصبح الحالة `connected` / `ready`

5. **تعيين جلسة التأكيد**
   - زر “تعيين” يحفظ الجلسة كـ session الافتراضية لإرسال رسائل الطلبات
   - زر “إلغاء التعيين”

#### Empty / Error states

- إذا `configured = false`:
  أظهر رسالة: لازم تتعبئة env في الـ backend:
  - `WHATSAPP_GATEWAY_URL`
  - `WHATSAPP_API_KEY`
  - `WHATSAPP_WEBHOOK_SECRET`

- إذا `503`: البوابة غير مُعدّة
- إذا `401/403`: المستخدم ليس أدمن / بدون صلاحية

---

### B) صفحة تفاصيل الطلب (أدمن)

أضف بلوك WhatsApp عندما:

```ts
order.status === "awaiting_confirmation"
```

محتوى البلوك:

- نص: “تم/يُتوقع إرسال رسالة تأكيد للعميل على الرقم {phone}”
- زر: **إعادة إرسال رسالة واتساب**
  - يستدعي `POST /whatsapp/orders/:id/resend-confirm`
  - أثناء الإرسال: loading
  - نجاح: toast “تم الإرسال”
  - فشل شائع:
    - `whatsapp_not_configured`
    - `no_session_assigned`
    - `no_phone`
    - `send_failed`

يمكن أيضاً إظهار الزر لحالات أخرى إذا احتجتم إعادة تنبيه، لكن المنطقي الأساسي هو `awaiting_confirmation`.

---

### C) واجهة العميل (Storefront)

لا تحتاج شاشة واتساب. فقط:

#### بعد Checkout COD

رسالة نجاح مثل:

> تم استلام طلبك رقم `{order_number}`.  
> هنبعتلك رسالة واتساب على `{phone}` للتأكيد.  
> رد بـ «نعم» للتأكيد أو «لا» للإلغاء.

#### بعد Paymob نجاح الدفع

نفس الرسالة تقريباً (الـ Backend بيرسل واتساب بعد الدفع).

#### صفحة تتبع الطلب `/orders/track` أو ما يقابلها

اعرض `status` بوضوح، خصوصاً:

- `awaiting_confirmation` → “بانتظار تأكيدك على واتساب”
- `confirmed` → “تم تأكيد طلبك”
- `cancelled` → “تم إلغاء الطلب”

Endpoint التتبع الحالي:

```http
GET /orders/track?order_number=...&phone=...
```

---

## 4) APIs بالتفصيل (للتنفيذ)

### 4.1 حالة النظام

```http
GET /whatsapp/status
```

Response `data`:

```ts
{
  configured: boolean;
  order_confirm_session_id: string | null;
}
```

---

### 4.2 قائمة الجلسات

```http
GET /whatsapp/sessions
```

Response `data`:

```ts
{
  sessions: unknown; // شكل بوابة الواتساب (غالباً array أو { sessions: [] })
  order_confirm_session_id: string | null;
}
```

**مهم:** بوابة الواتساب الخارجية قد ترجع الجلسات بأشكال مختلفة. طبّعها في الفرونت:

```ts
function asSessions(payload: unknown) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const o = payload as any;
    if (Array.isArray(o.sessions)) return o.sessions;
    if (Array.isArray(o.data)) return o.data;
  }
  return [];
}
```

حقول شائعة داخل الجلسة:

```ts
type WaSession = {
  id: string;
  status?: string;      // connecting | qr | connected | ready | disconnected...
  qr?: string | null;   // raw base64 أو data-url
  qrCode?: string | null;
  phone?: string | null;
};
```

عرض QR:

```ts
function qrSrc(session: WaSession) {
  const raw = session.qr || session.qrCode || "";
  if (!raw) return "";
  if (raw.startsWith("data:") || raw.startsWith("http")) return raw;
  return `data:image/png;base64,${raw}`;
}
```

---

### 4.3 إنشاء جلسة

```http
POST /whatsapp/sessions
Body: { "id": "arkan-orders" }
```

قيود:

- `id` من 2 إلى 80 حرف
- استخدم slug بسيط بدون مسافات: `arkan-orders`

Response: بيانات الجلسة الجديدة (غالباً فيها QR).

---

### 4.4 جلب جلسة واحدة (للـ QR)

```http
GET /whatsapp/sessions/:id
```

استعمله مع polling:

```ts
// كل 4 ثواني أثناء انتظار المسح
const detail = await api.get(`/whatsapp/sessions/${id}`);
```

أوقف الـ polling عندما الحالة تشير للاتصال (مثل `connected` / `ready` / `open`) أو عند مغادرة الصفحة.

---

### 4.5 إعادة اتصال (QR جديد)

```http
POST /whatsapp/sessions/:id/reconnect
Body: {}
```

استخدمه إذا انقطعت الجلسة أو QR انتهى.

---

### 4.6 حذف جلسة

```http
DELETE /whatsapp/sessions/:id
```

لو كانت هي جلسة التأكيد المعينة، الـ Backend يلغي التعيين تلقائياً.

---

### 4.7 تعيين جلسة تأكيد الطلبات

```http
PUT /whatsapp/settings
Body: { "order_confirm_session_id": "arkan-orders" }
```

لإلغاء التعيين:

```json
{ "order_confirm_session_id": null }
```

Response:

```ts
{ order_confirm_session_id: string | null }
```

بدون تعيين جلسة، رسائل تأكيد الطلبات **لن تُرسل**.

---

### 4.8 إعادة إرسال تأكيد لطلب

```http
POST /whatsapp/orders/:id/resend-confirm
```

`:id` = رقم الطلب الداخلي (`orders.id`) وليس `order_number`.

نجاح:

```ts
{ ok: true, sessionId: string }
```

فشل شائع (`400`):

```text
تعذر إرسال رسالة التأكيد (no_session_assigned)
تعذر إرسال رسالة التأكيد (whatsapp_not_configured)
تعذر إرسال رسالة التأكيد (no_phone)
تعذر إرسال رسالة التأكيد (send_failed)
```

ترجمها للأدمن:

| reason | رسالة UI |
|--------|----------|
| `whatsapp_not_configured` | بوابة واتساب غير مُعدّة في السيرفر |
| `no_session_assigned` | لم يتم تعيين جلسة تأكيد بعد |
| `no_phone` | الطلب بدون رقم هاتف |
| `send_failed` | فشل الإرسال عبر البوابة، حاول لاحقاً |
| `order_not_found` | الطلب غير موجود |

---

## 5) Client helpers جاهزة (إن كنت على Next في `arkan`)

الملف:

```text
arkan/src/lib/whatsapp.ts
```

الدوال:

- `fetchWhatsAppStatus(token)`
- `fetchWhatsAppSessions(token)`
- `createWhatsAppSession(token, id)`
- `fetchWhatsAppSession(token, id)`
- `reconnectWhatsAppSession(token, id)`
- `deleteWhatsAppSession(token, id)`
- `saveWhatsAppSettings(token, sessionId | null)`
- `resendWhatsAppConfirm(token, orderId)`

استخدمها مباشرة بدون إعادة كتابة طبقة الشبكة.

---

## 6) تدفق UX المقترح لإعداد الأدمن (Step by step)

1. افتح `/admin/whatsapp`
2. لو `configured=false` → أظهر تعليمات env (لا تحاول إنشاء جلسة)
3. أنشئ جلسة `arkan-orders`
4. اعرض QR وابدأ polling
5. امسح QR من واتساب الموبايل
6. بعد الاتصال: اضغط **تعيين**
7. اختبر بطلب COD حقيقي على رقمك
8. تأكد أن الطلب صار `awaiting_confirmation`
9. رد من واتساب بـ نعم/لا وتأكد من تحديث الحالة في صفحة الطلبات

Checklist نجاح:

- [ ] `configured = true`
- [ ] يوجد `order_confirm_session_id`
- [ ] جلسة status متصلة
- [ ] طلب تجريبي استلم رسالة واتساب
- [ ] رد نعم غيّر الحالة إلى `confirmed`
- [ ] رد لا غيّر الحالة إلى `cancelled`
- [ ] زر إعادة الإرسال من تفاصيل الطلب يعمل

---

## 7) تكامل صفحة الطلبات (Admin Orders)

### قائمة الطلبات

فلتر مقترح:

```ts
status=awaiting_confirmation
```

Endpoint الحالي:

```http
GET /orders?status=awaiting_confirmation&page=1&limit=20
```

Badge في الصف:

```tsx
{order.status === "awaiting_confirmation" && <Badge>واتساب</Badge>}
```

### تفاصيل الطلب

اعرض:

- `order.phone`
- `order.status`
- تاريخ الإنشاء
- زر resend

مثال استدعاء:

```ts
await resendWhatsAppConfirm(token, order.id);
```

---

## 8) رسائل العميل الجاهزة للنسخ في UI

### Checkout success (COD)

```text
تم تسجيل طلبك بنجاح ✅
رقم الطلب: {order_number}
هنبعتلك رسالة واتساب على {phone} فيها تفاصيل الطلب.
للتأكيد ابعت «نعم»، وللإلغاء ابعت «لا».
```

### Checkout success (Paymob)

```text
تم الدفع بنجاح ✅
رقم الطلب: {order_number}
خلال لحظات هتوصلك رسالة واتساب لتأكيد الطلب.
```

### Order tracking — awaiting

```text
طلبك بانتظار تأكيدك على واتساب.
لو الرسالة موصلتش، تواصل مع الدعم أو حاول لاحقاً.
```

---

## 9) أخطاء HTTP الشائعة وكيف تعرضها

| Status | المعنى | UI |
|--------|--------|----|
| 401 | غير مسجل / توكن منتهي | رجّع لـ `/login` |
| 403 | لا صلاحية | “ليس لديك صلاحية إدارة واتساب” |
| 404 | جلسة/طلب غير موجود | “غير موجود” |
| 400 | بيانات/إرسال فاشل | اعرض `message` من الـ API |
| 503 | البوابة غير مُعدّة | أظهر إعدادات env |

---

## 10) ملاحظات مهمة للفرونت

1. **لا تخزن** `WHATSAPP_API_KEY` في الفرونت أبداً.
2. Webhook خاص بالـ Backend فقط (`/webhooks/whatsapp`) — لا تنفذه في Next.
3. `order_confirm_session_id` لازم يتعيّن يدوياً مرة بعد ربط QR.
4. رقم الهاتف المصري يتنسّق في Backend تلقائياً (`01xxxxxxxxx` → `20...`).
5. لو العميل عنده أكثر من طلب بانتظار التأكيد، الـ AI قد يسأله أي رقم؛ الفرونت مش مسؤول عن الحوار ده.
6. حالة `pending_payment` **لا** تتأكد عبر واتساب قبل الدفع.

---

## 11) Wireframe سريع (Admin WhatsApp)

```text
┌──────────────────────────────────────────────┐
│ واتساب الطلبات                    [تحديث]   │
├───────────────┬──────────────────────────────┤
│ البوابة: OK   │ جلسة التأكيد: arkan-orders   │
├───────────────┴──────────────────────────────┤
│ إنشاء جلسة: [arkan-orders] [إنشاء]           │
├-----------------------┬----------------------┤
│ الجلسات               │ QR / تفاصيل الجلسة   │
│ • arkan-orders        │  [#### QR ####]      │
│   [عرض][تعيين][إعادة] │  الحالة: connected   │
│   [حذف]               │  [تحديث QR]          │
└───────────────────────┴──────────────────────┘
```

---

## 12) Wireframe سريع (Order details)

```text
┌──────────────────────────────────────┐
│ طلب #ARK-123     [بانتظار واتساب]   │
│ الهاتف: 01xxxxxxxxx                  │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ تأكيد واتساب                     │ │
│ │ أعد إرسال رسالة التأكيد للعميل   │ │
│ │              [إعادة الإرسال]     │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

---

## 13) ملفات مرجعية في الريبو

Backend:

- `src/services/whatsapp.ts`
- `src/services/orderConfirm.ts`
- `src/services/whatsappClassify.ts`
- `src/modules/whatsapp/routes.ts`
- `src/modules/webhooks/routes.ts`
- `docs/WHATSAPP_APIS.md`

Frontend الحالي:

- `arkan/src/lib/whatsapp.ts`
- `arkan/src/app/admin/whatsapp/page.tsx`

---

## 14) تعريف TypeScript جاهز للنسخ

```ts
export type WhatsAppStatus = {
  configured: boolean;
  order_confirm_session_id: string | null;
};

export type WhatsAppSession = {
  id: string;
  status?: string;
  qr?: string | null;
  qrCode?: string | null;
  phone?: string | null;
};

export type ResendConfirmResult = {
  ok: true;
  sessionId: string;
};

export type OrderStatusForWhatsApp =
  | "pending_payment"
  | "awaiting_confirmation"
  | "confirmed"
  | "cancelled"
  | string;
```

---

إذا نفّذت الشاشتين (Admin WhatsApp + Resend في تفاصيل الطلب) + رسائل النجاح/التتبع للعميل، تكون واجهة نظام الواتساب مكتملة من طرف الفرونت.
