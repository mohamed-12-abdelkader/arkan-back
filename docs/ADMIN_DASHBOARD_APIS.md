# Admin Dashboard APIs — توثيق كامل

Base URL: `http://localhost:8000/api/v1`  
(متاح أيضًا تحت `/api`)

كل endpoints الداشبورد تتطلب:

1. حساب أدمن: `users.role = admin`
2. صلاحية: `dashboard.read` (أو أي أدمن legacy بصلاحيات كاملة)
3. Header المصادقة:

```http
Authorization: Bearer <access_token>
```

الحصول على التوكن:

```http
POST /api/v1/login
Content-Type: application/json

{
  "email": "admin@example.com",
  "password": "your-password"
}
```

الاستجابة تحتوي على `data.access_token` و `data.permissions`.

صيغة الاستجابة العامة للنجاح:

```json
{
  "success": true,
  "data": {}
}
```

صيغة الخطأ:

```json
{
  "success": false,
  "status": 401,
  "message": "Unauthorized",
  "name": "HttpError"
}
```

---

## 1) نظرة عامة على الداشبورد — Overview

### `GET /dashboard/overview`

يرجع كل المقاييس الأساسية لشاشة الـ Admin Dashboard في طلب واحد.

| البند | القيمة |
|--------|--------|
| Method | `GET` |
| Path | `/api/v1/dashboard/overview` |
| Auth | Admin Bearer token |
| Permission | `dashboard.read` |
| Content-Type | — (query params فقط) |

### Query Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string (ISO date/timestamptz) | لا | بداية الفترة، مثال: `2026-01-01` أو `2026-01-01T00:00:00Z` |
| `to` | string (ISO date/timestamptz) | لا | نهاية الفترة، مثال: `2026-12-31` |

بدون `from`/`to` تُحسب المقاييس على **كل الطلبات** (ما عدا ما يُستثنى في التعريف).

### مثال طلب

```http
GET /api/v1/dashboard/overview?from=2026-01-01&to=2026-10-17
Authorization: Bearer eyJhbGciOi...
```

### مثال استجابة ناجحة

```json
{
  "success": true,
  "data": {
    "definitions": {
      "gross_sales": "Sum of order totals excluding cancelled orders",
      "net_sales": "Gross sales minus discounts",
      "recognized_revenue": "Totals for orders with paid/partially_refunded payment status"
    },
    "range": {
      "from": "2026-01-01",
      "to": "2026-10-17"
    },
    "sales": {
      "gross_sales": "125000.00",
      "net_sales": "118000.00",
      "recognized_revenue": "90000.00",
      "orders_count": 42,
      "average_order_value": "2976.19"
    },
    "orders_by_status": [
      { "status": "awaiting_confirmation", "count": 5 },
      { "status": "confirmed", "count": 8 },
      { "status": "processing", "count": 4 },
      { "status": "shipped", "count": 6 },
      { "status": "delivered", "count": 12 },
      { "status": "cancelled", "count": 3 }
    ],
    "customers": {
      "total_customers": 120,
      "new_customers": 15
    },
    "inventory": {
      "low_stock": 7,
      "out_of_stock": 2,
      "valuation": "450000.00"
    },
    "best_selling_products": [
      {
        "product_id": 12,
        "product_name": "RTX 4070",
        "qty_sold": 18,
        "revenue": "216000.00"
      }
    ],
    "recent_orders": [
      {
        "id": 55,
        "order_number": "ARK-20261017-123456",
        "status": "awaiting_confirmation",
        "payment_status": "pending",
        "total": "24999.00",
        "created_at": "2026-10-17T07:20:00.000Z"
      }
    ],
    "custom_builds": {
      "total_builds": 33,
      "avg_build_value": "28500.00"
    }
  }
}
```

### شرح حقول `data` بالتفصيل

#### `definitions`
تعريفات محاسبية صريحة حتى لا يُخلط بين إجمالي الطلبات والإيراد المعترف به.

| المفتاح | المعنى |
|---------|--------|
| `gross_sales` | مجموع `orders.total` لجميع الطلبات **غير الملغاة** (`status != cancelled`) ضمن الفترة |
| `net_sales` | `gross_sales` بعد طرح الخصومات: `SUM(total - discount_total)` للطلبات غير الملغاة |
| `recognized_revenue` | مجموع `total` فقط للطلبات التي `payment_status` فيها `paid` أو `partially_refunded` |

> **مهم:** إجمالي الطلبات ≠ الإيراد المعترف به. طلب COD مؤكد لكن غير محصّل لا يدخل في `recognized_revenue`.

#### `range`
يعيد قيم الفلتر المستخدمة (`from` / `to`) أو `null` إن لم تُرسل.

#### `sales`

| Field | Type | Description |
|-------|------|-------------|
| `gross_sales` | decimal string | إجمالي المبيعات الإجمالية |
| `net_sales` | decimal string | صافي المبيعات بعد الخصم |
| `recognized_revenue` | decimal string | إيراد معترف به حسب حالة الدفع |
| `orders_count` | integer | عدد الطلبات غير الملغاة في الفترة |
| `average_order_value` | decimal string | متوسط قيمة الطلب (`AVG(total)`) للطلبات غير الملغاة |

#### `orders_by_status`
مصفوفة تجميع بعدد الطلبات لكل حالة ضمن الفترة (يشمل الملغاة أيضًا لأن الفلتر هنا على التاريخ فقط).

حالات شائعة:

| Status | المعنى |
|--------|--------|
| `pending` / `pending_payment` | بانتظار الدفع |
| `awaiting_confirmation` | بانتظار تأكيد الإدارة |
| `confirmed` | مؤكد |
| `processing` | قيد التجهيز |
| `ready_for_shipment` | جاهز للشحن |
| `shipped` | تم الشحن |
| `delivered` | تم التسليم |
| `cancelled` | ملغي |
| `return_requested` / `returned` | مرتجع |
| `partially_refunded` / `refunded` | مسترد جزئيًا / كليًا |

يمكن للفرونت رسم بطاقات: Pending / Confirmed / Shipped / Delivered / Cancelled من هذه المصفوفة.

#### `customers`

| Field | Description |
|-------|-------------|
| `total_customers` | عدد المستخدمين `role = user` (كل العملاء) |
| `new_customers` | العملاء الجدد منذ `from` إن وُجد، وإلا خلال آخر **30 يومًا** |

#### `inventory`

| Field | Description |
|-------|-------------|
| `low_stock` | عدد المنتجات النشطة التي `(stock - reserved_stock) <= low_stock_threshold` |
| `out_of_stock` | عدد المنتجات النشطة التي المتاح فيها `<= 0` |
| `valuation` | تقييم المخزون: `SUM(stock * COALESCE(cost_price, price))` للمنتجات المتتبَّع مخزونها |

#### `best_selling_products`
أعلى 10 منتجات مبيعًا (حسب الكمية) ضمن الفترة، من `order_items` المرتبطة بطلبات غير ملغاة، مع استبعاد بنود الـ Custom Build التي `product_id IS NULL`.

| Field | Description |
|-------|-------------|
| `product_id` | معرّف المنتج |
| `product_name` | اسم المنتج وقت البيع (snapshot في الطلب) |
| `qty_sold` | إجمالي الكمية المباعة |
| `revenue` | مجموع `line_total` |

#### `recent_orders`
آخر **10 طلبات** إجمالًا (بدون فلتر فترة) — مناسبة لجدول "أحدث الطلبات" في أعلى الداشبورد.

| Field | Description |
|-------|-------------|
| `id` | معرّف الطلب |
| `order_number` | رقم الطلب الظاهر للإدارة |
| `status` | حالة التنفيذ |
| `payment_status` | حالة الدفع |
| `total` | الإجمالي |
| `created_at` | وقت الإنشاء |

#### `custom_builds`

| Field | Description |
|-------|-------------|
| `total_builds` | عدد تجميعات PC غير المؤرشفة |
| `avg_build_value` | متوسط `subtotal` لتلك التجميعات |

### أكواد الاستجابة

| Code | السبب |
|------|--------|
| `200` | نجاح |
| `400` | query غير صالح |
| `401` | بدون توكن / توكن غير صالح |
| `403` | ليس أدمن أو لا يملك `dashboard.read` |

---

## 2) اتجاه المبيعات — Sales Trend

### `GET /dashboard/sales-trend`

يرجع سلسلة زمنية للمبيعات والطلبات لرسم Charts (يوم / أسبوع / شهر / ربع / سنة).

| البند | القيمة |
|--------|--------|
| Method | `GET` |
| Path | `/api/v1/dashboard/sales-trend` |
| Auth | Admin Bearer token |
| Permission | `dashboard.read` |

### Query Parameters

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `from` | string | لا | — | بداية الفترة |
| `to` | string | لا | — | نهاية الفترة |
| `bucket` | enum | لا | `day` | وحدة التجميع: `day` \| `week` \| `month` \| `quarter` \| `year` |

### مثال طلب

```http
GET /api/v1/dashboard/sales-trend?bucket=month&from=2026-01-01&to=2026-10-31
Authorization: Bearer eyJhbGciOi...
```

### مثال استجابة

```json
{
  "success": true,
  "data": [
    {
      "period": "2026-01-01T00:00:00.000Z",
      "orders": 10,
      "sales": "45000.00"
    },
    {
      "period": "2026-02-01T00:00:00.000Z",
      "orders": 14,
      "sales": "62000.00"
    }
  ]
}
```

### شرح الحقول

| Field | Description |
|-------|-------------|
| `period` | بداية الفترة حسب `date_trunc(bucket, created_at)` |
| `orders` | عدد الطلبات غير الملغاة في هذه الفترة |
| `sales` | مجموع `orders.total` للطلبات غير الملغاة |

> الطلبات الملغاة (`cancelled`) **مستبعدة** من الترند.

### استخدام مقترح في الفرونت

| `bucket` | استخدام UI |
|----------|------------|
| `day` | آخر 30 يوم |
| `week` | آخر 12 أسبوع |
| `month` | آخر 12 شهر |
| `quarter` | مقارنة أرباع السنة |
| `year` | نظرة سنوية |

---

## 3) Endpoints مساعدة لشاشات الداشبورد

هذه ليست تحت `/dashboard` لكنها تُستخدم عادة بجانب الـ overview في لوحة الأدمن.

### 3.1 مخزون منخفض — تفاصيل

```http
GET /api/v1/inventory/low-stock
Authorization: Bearer <token>
```

| Permission | `inventory.manage` |
| Response | قائمة منتجات منخفضة المخزون |

```json
{
  "success": true,
  "data": [
    {
      "id": 3,
      "name": "DDR5 16GB",
      "sku": "RAM-16-1",
      "stock": 4,
      "reserved_stock": 1,
      "low_stock_threshold": 5,
      "available": 3
    }
  ]
}
```

استخدمها لجدول "تنبيهات المخزون" تحت بطاقة `inventory.low_stock` في الـ overview.

### 3.2 قائمة الطلبات (فلترة للإدارة)

```http
GET /api/v1/orders?status=awaiting_confirmation&page=1&limit=20
Authorization: Bearer <token>
```

| Permission | `orders.read` |

Query مدعومة: `status`, `payment_status`, `from`, `to`, `q`, `page`, `limit`

### 3.3 تفاصيل طلب واحد

```http
GET /api/v1/orders/:id
Authorization: Bearer <token>
```

يرجع الطلب + `items` + `history` + `payments` (ومعه `build_snapshot` إن كان Custom PC).

### 3.4 تغيير حالة طلب

```http
PATCH /api/v1/orders/:id/status
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "confirmed",
  "note": "تم التأكيد هاتفيًا"
}
```

| Permission | `orders.manage` |

الانتقالات غير الصالحة تُرفض بـ `400`.

---

## 4) صلاحيات مرتبطة بالداشبورد

| Permission | الاستخدام |
|------------|-----------|
| `dashboard.read` | `/dashboard/overview` و `/dashboard/sales-trend` |
| `orders.read` | قائمة/تفاصيل الطلبات |
| `orders.manage` | تغيير الحالة |
| `inventory.manage` | low-stock والتعديلات |
| `reports.financial` | محجوز لتقارير مالية أعمق لاحقًا |

الأدوار التي تملك `dashboard.read` افتراضيًا:  
`super_admin`, `store_manager`, `inventory_manager`, `order_manager`, `marketing_manager`, `finance_manager`

---

## 5) تدفق مقترح لبناء شاشة الداشبورد

```text
1. Login → احفظ access_token
2. GET /dashboard/overview?from=&to=     → KPI cards + جداول سريعة
3. GET /dashboard/sales-trend?bucket=day → Chart المبيعات
4. GET /inventory/low-stock              → تنبيهات المخزون (اختياري)
5. عند الضغط على طلب: GET /orders/:id
```

### توزيع بيانات Overview على الـ UI

| قسم الواجهة | مصدر البيانات |
|-------------|----------------|
| إجمالي المبيعات | `sales.gross_sales` |
| صافي المبيعات | `sales.net_sales` |
| الإيراد المحصّل | `sales.recognized_revenue` |
| عدد الطلبات | `sales.orders_count` |
| متوسط قيمة الطلب | `sales.average_order_value` |
| بطاقات الحالات | `orders_by_status` |
| العملاء / الجدد | `customers.*` |
| تنبيه مخزون | `inventory.low_stock` / `out_of_stock` |
| قيمة المخزون | `inventory.valuation` |
| الأكثر مبيعًا | `best_selling_products` |
| أحدث الطلبات | `recent_orders` |
| إحصائيات التجميع | `custom_builds.*` |
| رسم بياني زمني | `/dashboard/sales-trend` |

---

## 6) ملاحظات مهمة للمطورين

1. **الأسعار والقيم Decimal** ترجع كنصوص (`"125000.00"`) — لا تستخدم `float` في الحسابات على الفرونت إن أمكن.
2. **لا تعتمد على أرقام يرسلها العميل**؛ كل المقاييس محسوبة من قاعدة البيانات.
3. فلتر `from`/`to` يُطبَّق على `orders.created_at` لمعظم مقاييس المبيعات.
4. `recent_orders` و`inventory.*` و`custom_builds` حاليًا **بدون** تقييد بنفس `from`/`to` (مخزون وتجميعات = حالة حالية).
5. العملة الافتراضية للمتجر: **EGP** (من `store_settings`).
6. المنطقة الزمنية الافتراضية: **Africa/Cairo**.

---

## 7) أخطاء شائعة

| مشكلة | الحل |
|--------|------|
| `401 Unauthorized` | تأكد من إرسال Bearer token صالح |
| `403 Forbidden` | الحساب ليس admin أو ينقصه `dashboard.read` |
| أرقام أصفار رغم وجود طلبات | الطلبات ملغاة أو خارج فترة `from`/`to` |
| `recognized_revenue = 0` بينما يوجد طلبات | `payment_status` لم يصل بعد لـ `paid` |

---

## 8) ملخص سريع

| Endpoint | الغرض |
|----------|--------|
| `GET /dashboard/overview` | كل KPIs الداشبورد في استجابة واحدة |
| `GET /dashboard/sales-trend` | سلسلة زمنية للمبيعات والطلبات |
| `GET /inventory/low-stock` | تفاصيل المنتجات منخفضة المخزون |
| `GET /orders` | إدارة/بحث الطلبات |
| `GET /orders/:id` | تفاصيل طلب |
| `PATCH /orders/:id/status` | تحديث حالة الطلب |
