# توثيق تفصيلي — APIs العميل (حساب · سلة · طلب · تتبع)

**Base URL:** `http://localhost:8000/api/v1`  
(متاح أيضًا تحت `/api`)

**صيغة النجاح العامة:**

```json
{ "success": true, "data": {} }
```

**قائمة مع pagination:**

```json
{
  "success": true,
  "data": [],
  "meta": { "total": 100, "page": 1, "limit": 20, "totalPages": 5 }
}
```

**صيغة الخطأ الشائعة:**

```json
{
  "success": false,
  "status": 400,
  "message": "وصف الخطأ"
}
```

| HTTP | معنى شائع |
|------|-----------|
| `200` | نجاح قراءة/تحديث |
| `201` | تم الإنشاء |
| `400` | بيانات ناقصة / مخزون / تحقق |
| `401` | يحتاج تسجيل دخول |
| `403` | ممنوع |
| `404` | غير موجود |
| `409` | تعارض (مثل هاتف مسجّل مسبقًا) |

---

## فهرس الـ Endpoints

| # | Method | Path | Auth | الوصف |
|---|--------|------|------|--------|
| 1 | `POST` | `/user/register` | — | إنشاء حساب (اسم + هاتف + باسورد) |
| 2 | `POST` | `/login` | — | تسجيل دخول |
| 3 | `POST` | `/logout` | Bearer | تسجيل خروج |
| 4 | `POST` | `/refresh` | — | تجديد التوكن |
| 5 | `GET` | `/user/me` | Bearer | الملف الشخصي |
| 6 | `GET` | `/cart` | اختياري | جلب السلة |
| 7 | `POST` | `/cart/items` | اختياري | إضافة للسلة |
| 8 | `PATCH` | `/cart/items/:id` | اختياري | تعديل كمية |
| 9 | `DELETE` | `/cart/items/:id` | اختياري | حذف سطر |
| 10 | `POST` | `/cart/coupon` | اختياري | تطبيق كوبون |
| 11 | `DELETE` | `/cart/coupon` | اختياري | إزالة كوبون |
| 12 | `POST` | `/cart/merge` | Bearer | دمج سلة الضيف بعد الدخول |
| 13 | `POST` | `/orders/checkout` | اختياري | طلب كل محتويات السلة |
| 14 | `POST` | `/orders/buy-now` | اختياري | شراء منتج واحد مباشرة |
| 15 | `GET` | `/orders/track` | — | تتبع بالرقم + الهاتف |
| 16 | `GET` | `/orders/me` | Bearer | قائمة طلبات الحساب |
| 17 | `GET` | `/orders/me/:id` | Bearer | تفاصيل طلب للحساب |

---

# الجزء 1 — الحساب والمصادقة

## 1.1 إنشاء حساب

### `POST /user/register`

بدون Auth.

يُنشئ مستخدمًا بدور `user` (عميل عادي، ليس أدمن).

### Body

| الحقل | النوع | مطلوب | ملاحظات |
|-------|-------|-------|---------|
| `name` | string | نعم | اسم العميل |
| `phone` | string | نعم | `8–15` رقم، يمكن يبدأ بـ `+` |
| `password` | string | نعم | الحد الأدنى `6` أحرف |
| `email` | string (email) | لا | اختياري بالكامل |

### مثال طلب

```http
POST /api/v1/user/register
Content-Type: application/json

{
  "name": "أحمد محمد",
  "phone": "01012345678",
  "password": "secret123"
}
```

### نجاح `201`

```json
{
  "success": true,
  "data": {
    "user": {
      "id": 12,
      "name": "أحمد محمد",
      "phone": "01012345678",
      "email": null,
      "role": "user",
      "avatar": null,
      "is_staff": false,
      "created_at": "2026-10-23T07:00:00.000Z"
    },
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "....",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

> `token` مرادف لـ `access_token` للتوافق مع الواجهات القديمة.

### أخطاء شائعة

| Status | Message تقريبي | السبب |
|--------|----------------|-------|
| `400` | validation | حقل ناقص أو هاتف غير صالح |
| `409` | Email or phone already registered | الهاتف (أو الإيميل) مستخدم |

### ملاحظات للفرونت

- بعد التسجيل احفظ `access_token` و`refresh_token` (مثلًا في `localStorage`).
- أرسل لاحقًا: `Authorization: Bearer <access_token>`.
- لو كان للضيف `guest_token` للسلة، بعد التسجيل/الدخول نادِ `POST /cart/merge`.

---

## 1.2 تسجيل الدخول

### `POST /login`

بدون Auth.

| الحقل | مطلوب | ملاحظات |
|-------|-------|---------|
| `phone` | واحد من الاثنين | يُفضَّل للعملاء |
| `email` | واحد من الاثنين | اختياري |
| `password` | نعم | |

### مثال

```http
POST /api/v1/login
Content-Type: application/json

{
  "phone": "01012345678",
  "password": "secret123"
}
```

### نجاح `200`

نفس شكل بيانات المستخدم + `access_token` + `refresh_token`.

### أخطاء

| Status | السبب |
|--------|--------|
| `400` | بيانات خاطئة |
| `403` | الحساب موقوف |
| `429` | محاولات كثيرة / قفل مؤقت |

---

## 1.3 تجديد التوكن / تسجيل الخروج / الملف الشخصي

### `POST /refresh`

```json
{ "refresh_token": "..." }
```

يرجع زوج توكن جديد.

### `POST /logout`

يحتاج Bearer. يلغي الجلسة/التوكنات.

### `GET /user/me`

يحتاج Bearer. يرجع بيانات المستخدم الحالي.

### `PUT /user/me`

يحتاج Bearer. تحديث `name` / `phone` / `email` / `password` (اختياري لكل حقل).

---

# الجزء 2 — السلة

تعمل لـ **ضيف** أو **مسجّل**.

| نوع المستخدم | كيف تُعرَّف السلة |
|--------------|-------------------|
| مسجّل | من `Authorization: Bearer ...` |
| ضيف | `guest_token` (query أو body حسب الـ endpoint) |

> عند أول تعامل مع السلة كضيف، السيرفر يُنشئ `guest_token` (UUID) — **احفظه محليًا** وأعد إرساله دائمًا.

---

## 2.1 جلب السلة

### `GET /cart`

Auth اختياري.

| Query | مطلوب |
|-------|-------|
| `guest_token` | للضيف نعم (بعد إنشائه أول مرة؛ أول طلب بدونها يُنشئ واحدة جديد) |

```http
GET /api/v1/cart?guest_token=550e8400-e29b-41d4-a716-446655440000
```

أو لمستخدم مسجّل:

```http
GET /api/v1/cart
Authorization: Bearer <access_token>
```

### مثال رد

```json
{
  "success": true,
  "data": {
    "guest_token": "550e8400-e29b-41d4-a716-446655440000",
    "cart": {
      "id": 3,
      "user_id": null,
      "guest_token": "550e8400-e29b-41d4-a716-446655440000",
      "coupon_code": null
    },
    "items": [
      {
        "id": 10,
        "cart_id": 3,
        "product_id": 12,
        "variant_id": null,
        "quantity": 2,
        "name": "ASUS RTX 4070 12GB",
        "unit_price": "26900.00",
        "line_total": "53800.00"
      }
    ],
    "pricing": {
      "subtotal": "53800.00",
      "discount": "0.00",
      "tax": "0.00",
      "shipping": "0.00",
      "total": "53800.00",
      "currency": "EGP"
    }
  }
}
```

---

## 2.2 إضافة منتج للسلة

### `POST /cart/items`

Auth اختياري.

| الحقل | النوع | مطلوب | ملاحظات |
|-------|-------|-------|---------|
| `product_id` | number | نعم* | منتج عادي |
| `build_id` | number | نعم* | أو تجميعة PC (*واحد منهما) |
| `variant_id` | number | لا | متغير المنتج |
| `quantity` | number | لا | افتراضي `1` |
| `guest_token` | string | للضيف | |

```http
POST /api/v1/cart/items
Content-Type: application/json

{
  "product_id": 12,
  "quantity": 1,
  "guest_token": "550e8400-e29b-41d4-a716-446655440000"
}
```

- لو نفس المنتج موجود مسبقًا: تُحدَّث الكمية.  
- يتحقق من المخزون وحالة المنتج (`active`).  
- الرد: نفس ملخص السلة + `guest_token`.

---

## 2.3 تعديل كمية سطر

### `PATCH /cart/items/:id`

`:id` = رقم سطر السلة (`items[].id`).

```json
{
  "quantity": 3,
  "guest_token": "..."
}
```

---

## 2.4 حذف سطر

### `DELETE /cart/items/:id?guest_token=...`

للمسجّل يكفي Bearer بدون query.

---

## 2.5 كوبون

### تطبيق

`POST /cart/coupon`

```json
{ "code": "SAVE50", "guest_token": "..." }
```

### إزالة

`DELETE /cart/coupon?guest_token=...`

---

## 2.6 دمج سلة الضيف بعد الدخول

### `POST /cart/merge`

يحتاج Bearer.

```json
{ "guest_token": "550e8400-e29b-41d4-a716-446655440000" }
```

ينقل أسطر سلة الضيف لسلة المستخدم ثم يحذف سلة الضيف.

---

# الجزء 3 — إنشاء الطلبات

كلا المسارين يعملان لـ **ضيف أو مسجّل**.  
البيانات الأساسية المطلوبة من العميل:

- اسم العميل  
- رقم هاتف للتواصل  
- العنوان  
- طريقة الدفع: حاليًا `cod` (عند الاستلام) — مستقبلًا بوابات أخرى عبر نفس الحقل  

الأسعار والمخزون تُحسب **دائمًا من السيرفر** (لا تُوثق أسعار العميل).

الحالة الابتدائية للطلب: **`awaiting_confirmation`**.

---

## 3.1 طلب محتويات السلة كاملة

### `POST /orders/checkout`

Auth اختياري.

### Body

| الحقل | النوع | مطلوب | الوصف |
|-------|-------|-------|--------|
| `phone` | string | نعم | هاتف التواصل (يُستخدم أيضًا في التتبع) |
| `shipping_address.full_name` | string | نعم | اسم العميل |
| `shipping_address.phone` | string | نعم | هاتف العنوان |
| `shipping_address.address_line1` | string | نعم | العنوان التفصيلي |
| `shipping_address.city` | string | لا | المدينة |
| `shipping_address.governorate` | string | لا | المحافظة |
| `shipping_address.address_line2` | string | لا | تكملة عنوان |
| `shipping_address.postal_code` | string | لا | |
| `payment_method` | `cod` \| `bank_transfer` | لا | افتراضي `cod` |
| `customer_notes` | string | لا | ملاحظات للعميل |
| `guest_token` | string | للضيف | لربط السلة |
| `guest_email` | string | لا | اختياري |
| `billing_address` | object | لا | افتراضيًا = عنوان الشحن |
| `shipping_method_code` | string | لا | |

### مثال طلب (ضيف)

```http
POST /api/v1/orders/checkout
Content-Type: application/json

{
  "phone": "01012345678",
  "payment_method": "cod",
  "guest_token": "550e8400-e29b-41d4-a716-446655440000",
  "shipping_address": {
    "full_name": "أحمد محمد",
    "phone": "01012345678",
    "governorate": "القاهرة",
    "city": "مدينة نصر",
    "address_line1": "شارع مصطفى النحاس، عمارة 12، شقة 5"
  },
  "customer_notes": "اتصل قبل التوصيل بنصف ساعة"
}
```

### مثال طلب (مسجّل)

نفس الـ body مع:

```http
Authorization: Bearer <access_token>
```

(يمكن حذف `guest_token` لو السلة مرتبطة بالحساب).

### سلوك السيرفر

1. يقرأ السلة (يوزر أو ضيف).  
2. يتحقق من توفر المنتجات/التجميعات والمخزون.  
3. يعيد حساب الأسعار من قاعدة البيانات.  
4. ينشئ `orders` + `order_items` + `payments` + سجل حالة.  
5. يخصم المخزون.  
6. **يفرّغ السلة** بعد النجاح.  
7. يولّد `order_number` بصيغة مثل: `ARK-20261023-384291`.

### نجاح `201` (مثال مختصر)

```json
{
  "success": true,
  "data": {
    "id": 55,
    "order_number": "ARK-20261023-384291",
    "user_id": null,
    "status": "awaiting_confirmation",
    "payment_status": "pending",
    "fulfillment_status": "unfulfilled",
    "subtotal": "53800.00",
    "discount_total": "0.00",
    "tax_total": "0.00",
    "shipping_total": "0.00",
    "total": "53800.00",
    "currency": "EGP",
    "phone": "01012345678",
    "shipping_address_json": {
      "full_name": "أحمد محمد",
      "phone": "01012345678",
      "city": "مدينة نصر",
      "address_line1": "شارع مصطفى النحاس، عمارة 12، شقة 5"
    },
    "customer_notes": "اتصل قبل التوصيل بنصف ساعة",
    "created_at": "2026-10-23T08:15:00.000Z"
  }
}
```

### أخطاء شائعة

| Status | Message / سبب |
|--------|----------------|
| `400` | Cart is empty |
| `400` | Product unavailable / Insufficient stock |
| `400` | Build contains incompatible components |
| `400` | validation على العنوان/الهاتف |

### ملاحظات للفرونت

- بعد النجاح اعرض `order_number` بوضوح للضيف.  
- وجّه لصفحة التتبع مع `order_number` + `phone`.  
- الدفع الحالي: **عند الاستلام فقط** (`cod`).

---

## 3.2 شراء منتج واحد مباشرة (Buy Now)

### `POST /orders/buy-now`

Auth اختياري.

**لا يستخدم السلة ولا يفرّغها** — مناسب لزر «اشترِ الآن» من صفحة المنتج.

### Body

كل حقول العنوان/الدفع في checkout **بالإضافة إلى:**

| الحقل | النوع | مطلوب | ملاحظات |
|-------|-------|-------|---------|
| `product_id` | number | نعم | |
| `quantity` | number | لا | افتراضي `1` |
| `variant_id` | number \| null | لا | متغير إن وُجد |

### مثال

```http
POST /api/v1/orders/buy-now
Content-Type: application/json

{
  "product_id": 12,
  "quantity": 1,
  "phone": "01012345678",
  "payment_method": "cod",
  "shipping_address": {
    "full_name": "أحمد محمد",
    "phone": "01012345678",
    "address_line1": "العنوان بالكامل"
  }
}
```

### نجاح `201`

نفس شكل كائن الأوردر في checkout (مع `order_number` و`status: awaiting_confirmation`).

### أخطاء

| Status | السبب |
|--------|--------|
| `400` | المنتج غير متاح / غير نشط |
| `400` | المخزون غير كافٍ |
| `400` | المتغير غير متاح |

---

# الجزء 4 — متابعة الأوردر

## 4.1 تتبع عام (ضيف أو أي عميل)

### `GET /orders/track`

بدون Auth.

| Query | مطلوب |
|-------|-------|
| `order_number` | نعم |
| `phone` | نعم — نفس رقم `phone` المرسل عند إنشاء الطلب |

```http
GET /api/v1/orders/track?order_number=ARK-20261023-384291&phone=01012345678
```

### نجاح `200`

```json
{
  "success": true,
  "data": {
    "id": 55,
    "order_number": "ARK-20261023-384291",
    "status": "processing",
    "payment_status": "pending",
    "fulfillment_status": "unfulfilled",
    "subtotal": "26900.00",
    "discount_total": "0.00",
    "tax_total": "0.00",
    "shipping_total": "0.00",
    "total": "26900.00",
    "currency": "EGP",
    "phone": "01012345678",
    "shipping_address_json": { "...": "..." },
    "customer_notes": null,
    "created_at": "2026-10-23T08:15:00.000Z",
    "updated_at": "2026-10-23T10:00:00.000Z",
    "items": [
      {
        "id": 90,
        "product_id": 12,
        "variant_id": null,
        "product_name": "ASUS RTX 4070 12GB",
        "quantity": 1,
        "price": "26900.00",
        "line_total": "26900.00",
        "sku": "ASUS-4070"
      }
    ],
    "history": [
      {
        "from_status": null,
        "to_status": "awaiting_confirmation",
        "note": "Order placed",
        "created_at": "2026-10-23T08:15:00.000Z"
      },
      {
        "from_status": "awaiting_confirmation",
        "to_status": "confirmed",
        "note": "Confirmed by store",
        "created_at": "2026-10-23T09:00:00.000Z"
      },
      {
        "from_status": "confirmed",
        "to_status": "processing",
        "note": "Preparing package",
        "created_at": "2026-10-23T10:00:00.000Z"
      }
    ]
  }
}
```

### خطأ `404`

رقم الأوردر أو الهاتف غير متطابقين.

---

## 4.2 طلبات الحساب المسجّل

### `GET /orders/me`

يحتاج Bearer.

Query اختياري: `page`, `limit`.

يرجع قائمة طلبات المستخدم مع pagination.

### `GET /orders/me/:id`

يحتاج Bearer.

يرجع تفاصيل الطلب + `items` + `history` (فقط إن كان `user_id` = المستخدم الحالي).

---

# الجزء 5 — حالات الأوردر والدفع

## 5.1 حالات الطلب `status` (للعرض في الواجهة)

| القيمة | نص مقترح بالعربية |
|--------|-------------------|
| `awaiting_confirmation` | بانتظار التأكيد |
| `confirmed` | تم التأكيد |
| `processing` | جاري التجهيز |
| `ready_for_shipment` | جاهز للشحن |
| `shipped` | تم الشحن / جاري التوصيل |
| `delivered` | تم التسليم |
| `cancelled` | ملغي |
| `return_requested` | طلب إرجاع |
| `returned` | مُرجع |
| `pending` / `pending_payment` | بانتظار الدفع (مستقبلاً) |
| `refunded` / `partially_refunded` | مسترد |

### المسار الطبيعي للعميل

```text
awaiting_confirmation
        ↓
    confirmed
        ↓
    processing          ← جاري التجهيز
        ↓
ready_for_shipment
        ↓
      shipped           ← جاري الشحن
        ↓
     delivered
```

الأدمن يغيّر الحالة عبر:

`PATCH /orders/:id/status` (صلاحية `orders.manage`) — خارج نطاق واجهة العميل.

استخدم مصفوفة `history` لبناء تايملاين التتبع في الفرونت.

## 5.2 الدفع `payment_method`

| القيمة | الوضع الحالي |
|--------|----------------|
| `cod` | **مفعّل** — الدفع عند الاستلام |
| `bank_transfer` | موجود في الـ schema؛ جاهز للتوسع لاحقًا |

`payment_status` يبدأ عادةً `pending` مع COD حتى تأكيد الاستلام/التسليم حسب سياسة المتجر لاحقًا.

---

# الجزء 6 — سيناريوهات استخدام للفرونت

## سيناريو أ: ضيف يشتري من السلة

1. `POST /cart/items` → احفظ `guest_token`  
2. كرّر الإضافة/التعديل حسب الحاجة  
3. `POST /orders/checkout` بنفس `guest_token` + الاسم/الهاتف/العنوان/`cod`  
4. اعرض `order_number`  
5. التتبع: `GET /orders/track?order_number=&phone=`

## سيناريو ب: ضيف يضغط «اشترِ الآن»

1. من صفحة المنتج → `POST /orders/buy-now`  
2. التتبع بنفس رقم الأوردر والهاتف  

## سيناريو ج: عميل يسجّل حسابًا ثم يطلب

1. `POST /user/register` (اسم + هاتف + باسورد)  
2. لو عنده سلة ضيف: `POST /cart/merge`  
3. `POST /orders/checkout` مع Bearer  
4. متابعة لاحقة من `GET /orders/me`

## سيناريو د: عميل مسجّل يتابع طلباته

1. `POST /login`  
2. `GET /orders/me`  
3. `GET /orders/me/:id` لعرض التفاصيل والتايملاين  

---

# الجزء 7 — أمثلة `curl`

### تسجيل

```bash
curl -X POST http://localhost:8000/api/v1/user/register \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"أحمد\",\"phone\":\"01012345678\",\"password\":\"secret123\"}"
```

### إضافة للسلة (ضيف)

```bash
curl -X POST http://localhost:8000/api/v1/cart/items \
  -H "Content-Type: application/json" \
  -d "{\"product_id\":12,\"quantity\":1}"
```

### Checkout

```bash
curl -X POST http://localhost:8000/api/v1/orders/checkout \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"01012345678\",\"payment_method\":\"cod\",\"guest_token\":\"YOUR_TOKEN\",\"shipping_address\":{\"full_name\":\"أحمد\",\"phone\":\"01012345678\",\"address_line1\":\"العنوان\"}}"
```

### Buy now

```bash
curl -X POST http://localhost:8000/api/v1/orders/buy-now \
  -H "Content-Type: application/json" \
  -d "{\"product_id\":12,\"quantity\":1,\"phone\":\"01012345678\",\"payment_method\":\"cod\",\"shipping_address\":{\"full_name\":\"أحمد\",\"phone\":\"01012345678\",\"address_line1\":\"العنوان\"}}"
```

### تتبع

```bash
curl "http://localhost:8000/api/v1/orders/track?order_number=ARK-20261023-384291&phone=01012345678"
```

---

# الجزء 8 — ملاحظات تقنية مهمة

1. **لا ترسل سعر المنتج من الفرونت في الطلب** — السيرفر يعيد الحساب.  
2. **`phone` في جذر الـ checkout/buy-now** هو مفتاح التتبع العام؛ استخدم نفس الرقم في `/orders/track`.  
3. للعمل كضيف لا تحتاج إيميل.  
4. العملة الحالية في الأوردرات: **`EGP`**.  
5. تفاصيل إضافية عامة للكتالوج موجودة في `CATEGORIES_AND_PRODUCTS_APIS.md` و`API.md`.  

---

**آخر تحديث مرتبط بـ:** تسجيل بالهاتف، checkout بدون إيميل إلزامي، `POST /orders/buy-now`، `GET /orders/track`.
