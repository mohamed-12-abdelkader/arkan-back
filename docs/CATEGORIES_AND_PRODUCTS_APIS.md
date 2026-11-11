# إدارة الأصناف والمنتجات — توثيق APIs كامل

Base URL: `http://localhost:8000/api/v1`  
(متاح أيضًا تحت `/api`)

هذا المستند يشرح كيفية:

1. إضافة وإدارة **الأصناف (Categories)**
2. إضافة وإدارة **البراندات (Brands)** — مرتبطة بالمنتجات
3. إضافة وإدارة **المنتجات (Products)** والمتغيرات (Variants)
4. سير عمل مقترح من لوحة الأدمن

---

## المصادقة والصلاحيات

عمليات الكتابة (إضافة / تعديل / حذف) تتطلب:

```http
Authorization: Bearer <access_token>
```

| العملية | Permission |
|---------|------------|
| إدارة الأصناف | `categories.manage` |
| إدارة البراندات | `brands.manage` |
| إدارة المنتجات | `products.manage` |
| تعديل الأسعار (غير الـ admin الكامل) | `products.price` |

الحصول على التوكن:

```http
POST /api/v1/login
Content-Type: application/json

{ "email": "admin@example.com", "password": "..." }
```

صيغة النجاح العامة:

```json
{ "success": true, "data": {} }
```

قائمة مُقسّمة (pagination):

```json
{
  "success": true,
  "data": [],
  "meta": { "total": 100, "page": 1, "limit": 20, "totalPages": 5 }
}
```

---

# الجزء 1 — الأصناف (Categories)

الأصناف هرمية: تصنيف رئيسي → أصناف فرعية (`parent_id`).

**قاعدة مهمة:** لو التصنيف الرئيسي فيه أصناف فرعية، **المنتجات تُضاف على الفرعي فقط** مش على الرئيسي.

مثال:

```text
إكسسوارات                 (رئيسي — لا يستقبل منتجات)
  ├─ كيبوردات            (فرعي — هنا تُضاف المنتجات)
  ├─ ماوسات
  └─ كراسي
قطع الكمبيوتر             (رئيسي)
  ├─ معالجات
  ├─ كروت شاشة
  └─ رام
```

- `GET /categories?tree=true` يرجع الشجرة مع `children` و `is_leaf` و `accepts_products`
- `GET /categories/:idOrSlug` يرجع التصنيف + `children`
- `GET /categories/home` يرجع التصنيفات الرئيسية فقط، وكل واحد فيه `children` (الأصناف الفرعية)
- إضافة/تعديل منتج على تصنيف فيه أبناء → `400` مع رسالة عربية
- إضافة تصنيف فرعي تحت أب فيه منتجات مباشرة → `400` (انقل المنتجات للفرعي أولاً)

## 1.0 الصفحة الرئيسية — تصنيفات + منتجات

### `GET /categories/home`

عام — بدون Auth.  
مخصص للصفحة الرئيسية: كل تصنيف نشط، وتحته حتى **10 منتجات** (أو أقل لو الموجود أقل).

| Query | Default | Description |
|-------|---------|-------------|
| `limit` | `10` | أقصى عدد منتجات تحت كل تصنيف (1–50) |

```http
GET /api/v1/categories/home
GET /api/v1/categories/home?limit=10
```

```js
const res = await fetch('http://localhost:8000/api/v1/categories/home');
const { data } = await res.json();
// data = [ { id, name, products: [...] }, ... ]
```

مثال استجابة:

```json
{
  "success": true,
  "data": [
    {
      "id": 3,
      "name": "Graphics Cards",
      "slug": "graphics-cards",
      "description": null,
      "image": null,
      "parent_id": 1,
      "is_featured": true,
      "products_count": 2,
      "products": [
        {
          "id": 12,
          "name": "ASUS RTX 4070 12GB",
          "slug": "asus-rtx-4070-12gb",
          "price": "28500.00",
          "discount": "26900.00",
          "effective_price": "26900.00",
          "image": "/uploads/products/photo.jpg",
          "available_stock": 15,
          "is_featured": true
        },
        {
          "id": 14,
          "name": "RX 7800 XT",
          "slug": "rx-7800-xt",
          "price": "25000.00",
          "discount": null,
          "effective_price": "25000.00",
          "image": "/uploads/products/rx.jpg",
          "available_stock": 4,
          "is_featured": false
        }
      ]
    }
  ]
}
```

- المنتجات المعروضة: `status = active` فقط  
- الترتيب داخل التصنيف: المميزة أولًا ثم الأحدث  
- `products` معاينة حتى `limit` منتج، و`products_count` هو العدد الكلي للمنتجات النشطة في التصنيف  
- لو مفيش منتجات → `products: []` و `products_count: 0`

---

## 1.1 قائمة الأصناف

### `GET /categories`

عام — لا يحتاج Auth.

| Query | Type | Description |
|-------|------|-------------|
| `page` | number | افتراضي `1` |
| `limit` | number | افتراضي `20` (حد أقصى 100) |
| `q` | string | بحث في الاسم أو الـ slug |
| `parent_id` | number | أصناف فرعية لأب معيّن |
| `is_active` | `true` \| `false` | فلترة النشاط |
| `tree` | `true` \| `false` | لو `true` يرجع شجرة كاملة بدل صفحة مسطحة |

**قائمة عادية:**

```http
GET /api/v1/categories?page=1&limit=20
```

**شجرة كاملة (مناسبة لسايدبار الأدمن):**

```http
GET /api/v1/categories?tree=true
```

مثال استجابة الشجرة:

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "PC Components",
      "slug": "pc-components",
      "parent_id": null,
      "is_active": true,
      "children": [
        {
          "id": 2,
          "name": "Processors",
          "slug": "processors",
          "parent_id": 1,
          "children": []
        }
      ]
    }
  ]
}
```

## 1.2 تفاصيل صنف

### `GET /categories/:idOrSlug`

يقبل `id` رقمي أو `slug`.

```http
GET /api/v1/categories/processors
GET /api/v1/categories/2
```

## 1.2.1 منتجات تحت تصنيف (باجنيشن)

### `GET /categories/:idOrSlug/products`

عام — بدون Auth.  
يرجع منتجات تصنيف معيّن بباجنيشن. **الافتراضي 12 منتج في الصفحة.**

يقبل `id` أو `slug` للتصنيف.

| Query | Default | Description |
|-------|---------|-------------|
| `page` | `1` | رقم الصفحة |
| `limit` | `12` | عدد المنتجات في الصفحة (1–100) |
| `q` | — | بحث في الاسم / SKU / model / keywords |
| `brand_id` | — | فلتر براند |
| `min_price`, `max_price` | — | نطاق السعر |
| `in_stock` | — | `true` = المتاح > 0 |
| `featured` | — | `true` = المميزة فقط |
| `sort` | `created_at` | `price` \| `name` \| `created_at` \| `stock` |
| `order` | `desc` | `asc` \| `desc` |

```http
GET /api/v1/categories/3/products
GET /api/v1/categories/3/products?page=1&limit=12
GET /api/v1/categories/graphics-cards/products?page=2&sort=price&order=asc
```

```js
const res = await fetch(
  'http://localhost:8000/api/v1/categories/3/products?page=1&limit=12',
);
const { data, meta } = await res.json();
// data = منتجات الصفحة
// meta = { total, page, limit: 12, totalPages }
```

مثال استجابة:

```json
{
  "success": true,
  "data": [
    {
      "id": 12,
      "name": "ASUS RTX 4070 12GB",
      "slug": "asus-rtx-4070-12gb",
      "price": "28500.00",
      "sale_price": "26900.00",
      "effective_price": "26900.00",
      "image": "/uploads/products/photo.jpg",
      "brand_name": "ASUS",
      "category_name": "Graphics Cards",
      "available_stock": 15,
      "is_featured": true
    }
  ],
  "meta": {
    "total": 28,
    "page": 1,
    "limit": 12,
    "totalPages": 3
  }
}
```

- المنتجات: `status = active` و `is_active = true` فقط  
- لو التصنيف غير موجود → `404`  
- بديل عام: `GET /products?category_id=3&page=1&limit=12`

## 1.3 إضافة صنف

### `POST /categories`

| Auth | Admin |
| Permission | `categories.manage` |
| Content-Type | `multipart/form-data` |

الصورة تُختار من الجهاز (ملف)، تُحفظ في `uploads/categories`، وتُعرض عبر:

`http://localhost:8000/uploads/categories/<filename>`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | text | **نعم** | اسم الصنف |
| `description` | text | لا | وصف |
| `image` | **file** | لا | صورة من الجهاز |
| `parent_id` | number | لا | صنف أب |
| `display_order` | number | لا | ترتيب العرض |
| `is_featured` | `true`/`false` | لا | مميز |
| `is_active` | `true`/`false` | لا | افتراضي `true` |
| `slug` | text | لا | يُولَّد من الاسم |
| `seo_title` | text | لا | |
| `seo_description` | text | لا | |

**مثال فرونت:**

```js
const form = new FormData();
form.append('name', 'PC Components');
form.append('description', 'قطع الكمبيوتر');
form.append('display_order', '1');
form.append('is_featured', 'true');
form.append('is_active', 'true');
if (imageInput.files[0]) form.append('image', imageInput.files[0]);

await fetch('http://localhost:8000/api/v1/categories', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
```

**مثال — صنف فرعي + صورة:**

```bash
curl -X POST http://localhost:8000/api/v1/categories \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=Graphics Cards" \
  -F "parent_id=1" \
  -F "display_order=2" \
  -F "image=@/path/to/category.jpg"
```

استجابة `201` تتضمن `image` كمسار مثل `/uploads/categories/1710000000-category.jpg`.

## 1.4 تعديل صنف

### `PUT /categories/:id`

| Auth | Admin |
| Permission | `categories.manage` |
| Content-Type | `multipart/form-data` |

نفس حقول الإضافة — كلها اختيارية. أرسل ملف `image` فقط لو هتغيّر الصورة.

```js
const form = new FormData();
form.append('name', 'GPUs / Graphics Cards');
form.append('is_featured', 'true');
if (imageInput.files[0]) form.append('image', imageInput.files[0]);

await fetch(`http://localhost:8000/api/v1/categories/${id}`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
```

**قاعدة مهمة:** ممنوع إنشاء علاقة أب-ابن دائرية (circular). لو حاولت جعل صنف أبًا لنفسه أو لحفيده → `400`.

## 1.5 حذف صنف

### `DELETE /categories/:id`

| Auth | Admin |
| Permission | `categories.manage` |

```http
DELETE /api/v1/categories/3
Authorization: Bearer <token>
```

**الحذف مرفوض إذا:**

| الشرط | رسالة |
|--------|--------|
| الصنف فيه منتجات | `Category has products. Reassign or archive products before deleting.` |
| الصنف فيه أصناف فرعية | `Category has subcategories. Reassign them first.` |

الحل: انقل المنتجات/الأبناء أولًا ثم احذف.

---

# الجزء 2 — البراندات (Brands)

اختياري لكن مفيد لربط المنتج بعلامة تجارية (ASUS, Intel, AMD...).

## 2.1 قائمة / تفاصيل

```http
GET /api/v1/brands?q=asus&page=1&limit=20
GET /api/v1/brands/asus
```

## 2.2 إضافة براند

### `POST /brands`

| Permission | `brands.manage` |

```http
POST /api/v1/brands
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "ASUS",
  "slug": "asus",
  "description": "ASUS hardware",
  "logo": "https://cdn.example.com/asus.png",
  "website": "https://www.asus.com",
  "is_active": true
}
```

## 2.3 تعديل / حذف

```http
PUT /api/v1/brands/:id
DELETE /api/v1/brands/:id
```

عند الحذف يتم فك ارتباط المنتجات (`brand_id = null`) دون حذف المنتجات نفسها.

---

# الجزء 3 — المنتجات (Products)

## حالات المنتج `status`

| Value | المعنى |
|-------|--------|
| `draft` | مسودة — غير ظاهر في الكتالوج العام |
| `active` | منشور وقابل للبيع |
| `archived` | مؤرشف (ناتج الحذف الناعم) |

الكتالوج العام (`GET /products` بدون `status`) يعرض فقط: `status=active` و `is_active=true`.

للإدارة: أرسل `?status=draft` أو `?status=archived` لعرض المسودات/المؤرشف.

## 3.1 قائمة المنتجات

### `GET /products`

عام (مع فلاتر).

| Query | Description |
|-------|-------------|
| `page`, `limit` | ترقيم |
| `q` | بحث في الاسم / SKU / model / keywords |
| `category_id` | حسب الصنف |
| `brand_id` | حسب البراند |
| `component_type` | مثل `cpu`, `gpu`, `ram` |
| `status` | `draft` \| `active` \| `archived` |
| `min_price`, `max_price` | نطاق السعر |
| `in_stock` | `true` = المتاح > 0 |
| `featured` | `true` = المميزة فقط |
| `sort` | `price` \| `name` \| `created_at` \| `stock` |
| `order` | `asc` \| `desc` |

```http
GET /api/v1/products?category_id=3&status=active&sort=price&order=asc&page=1
```

كل عنصر في القائمة يتضمن:

- `effective_price` — السعر الفعلي (يشمل التخفيض إن كان ساريًا)
- `available_stock` — `stock - reserved_stock`
- `brand_name`, `category_name`

## 3.1.1 الأكثر طلبًا (منتجات عشوائية من كل الأصناف)

### `GET /products/popular`

عام — بدون Auth.

يعرض المنتجات النشطة من **كل الأصناف** بترتيب عشوائي (مناسب لقسم «الأكثر طلبًا» في الواجهة).

**ملاحظة:** لا يعرض قطع نظام التجميعة (`component_type` مثل cpu / gpu / ram) — منتجات المتجر فقط.

| Query | Default | Description |
|-------|---------|-------------|
| `page` | `1` | رقم الصفحة |
| `limit` | `12` | عدد المنتجات (حد أقصى 100) |
| `in_stock` | — | `true` للمتوفر فقط |
| `seed` | — | نص اختياري لتثبيت الترتيب العشوائي أثناء التنقل بين الصفحات |

```http
GET /api/v1/products/popular
GET /api/v1/products/popular?page=1&limit=12
GET /api/v1/products/popular?seed=home-2026-11&page=2&limit=12
```

```json
{
  "success": true,
  "data": [
    {
      "id": 12,
      "name": "كيبورد ميكانيكي",
      "slug": "mech-keyboard",
      "price": "2500.00",
      "effective_price": "2500.00",
      "available_stock": 8,
      "brand_name": "Logitech",
      "category_name": "كيبوردات",
      "image": "/uploads/products/..."
    }
  ],
  "meta": { "total": 40, "page": 1, "limit": 12, "totalPages": 4 }
}
```

> استخدم `seed` ثابت في الجلسة لو عايز الصفحة 2 تكمل نفس الترتيب ومش تعيد خلط المنتجات.

## 3.2 تفاصيل منتج

### `GET /products/:idOrSlug`

عام — بدون Auth. يقبل `id` أو `slug`.

```http
GET /api/v1/products/12
GET /api/v1/products/asus-rtx-4070-12gb
```

```js
const res = await fetch(`http://localhost:8000/api/v1/products/${idOrSlug}`);
const { data } = await res.json();
```

مثال استجابة:

```json
{
  "success": true,
  "data": {
    "id": 12,
    "name": "ASUS RTX 4070 12GB",
    "slug": "asus-rtx-4070-12gb",
    "description": "كرت شاشة للألعاب",
    "price": "28500.00",
    "discount": "26900.00",
    "cost_price": "24000.00",
    "effective_price": "26900.00",
    "stock": 15,
    "available_stock": 15,
    "status": "active",
    "is_active": true,
    "image": "/uploads/products/1710000000-photo1.jpg",
    "images": [
      { "id": 1, "url": "/uploads/products/1710000000-photo1.jpg", "position": 0 }
    ],
    "brand": {
      "id": 1,
      "name": "ASUS",
      "slug": "asus",
      "logo": "/uploads/brands/logo.png"
    },
    "category": {
      "id": 3,
      "name": "Graphics Cards",
      "slug": "graphics-cards"
    },
    "variants": [],
    "created_at": "...",
    "updated_at": "..."
  }
}
```

صور المنتج تُعرض كاملة عبر: `http://localhost:8000` + `image` أو `images[].url`

لو المنتج غير موجود → `404`.

## 3.3 إضافة / تعديل منتج (multipart + رفع صور من الجهاز)

### `POST /products` — إضافة
### `PUT /products/:id` — تعديل

| Auth | Admin |
| Permission | `products.manage` |
| Content-Type | `multipart/form-data` |

الصور تُختار من جهاز المستخدم، تُحفظ على السيرفر في مجلد `uploads/products`، وتُعرض عبر:

`http://localhost:8000/uploads/products/<filename>`

### حقول الفورم

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | text | **نعم** | اسم المنتج |
| `description` | text | لا | الوصف |
| `price` | number | لا | السعر (افتراضي 0) |
| `discount` | number | لا | سعر الخصم / التخفيض |
| `cost_price` | number | لا | سعر التكلفة |
| `stock` | number | لا | المخزون (افتراضي 0) |
| `category_id` | number | لا | التصنيف |
| `brand_id` | number | لا | البراند |
| `status` | text | لا | `draft` \| `active` \| `archived` (افتراضي `active`) |
| `images` | file[] | لا | صور من الجهاز (حتى 10، كل صورة ≤ 5MB) |

> `discount` يُخزَّن كـ `sale_price` ويُرجع في التفاصيل باسم `discount` أيضًا.

### مثال من الفرونت (FormData)

```js
const form = new FormData();
form.append('name', 'ASUS RTX 4070 12GB');
form.append('description', 'كرت شاشة للألعاب'); // اختياري
form.append('price', '28500');
form.append('discount', '26900');               // اختياري — سعر بعد الخصم
form.append('cost_price', '24000');             // اختياري
form.append('stock', '15');
form.append('category_id', '3');
form.append('brand_id', '1');
form.append('status', 'active');

// اختيار صور من الجهاز
for (const file of fileInput.files) {
  form.append('images', file);
}

await fetch('http://localhost:8000/api/v1/products', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  // لا تضع Content-Type يدويًا — المتصفح يضبط الـ boundary
  body: form,
});
```

### أصغر مثال

```js
const form = new FormData();
form.append('name', 'كابل HDMI');
await fetch('/api/v1/products', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
```

### مثال cURL

```bash
curl -X POST http://localhost:8000/api/v1/products \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=ASUS RTX 4070 12GB" \
  -F "description=كرت شاشة" \
  -F "price=28500" \
  -F "discount=26900" \
  -F "cost_price=24000" \
  -F "stock=15" \
  -F "category_id=3" \
  -F "brand_id=1" \
  -F "status=active" \
  -F "images=@/path/to/photo1.jpg" \
  -F "images=@/path/to/photo2.jpg"
```

### استجابة `201`

```json
{
  "success": true,
  "data": {
    "id": 12,
    "name": "ASUS RTX 4070 12GB",
    "description": "كرت شاشة",
    "price": "28500.00",
    "discount": "26900.00",
    "cost_price": "24000.00",
    "stock": 15,
    "category_id": 3,
    "brand_id": 1,
    "status": "active",
    "image": "/uploads/products/1710000000-photo1.jpg",
    "images": [
      { "id": 1, "url": "/uploads/products/1710000000-photo1.jpg", "position": 0 },
      { "id": 2, "url": "/uploads/products/1710000001-photo2.jpg", "position": 1 }
    ]
  }
}
```

عند التعديل (`PUT`): نفس الحقول اختيارية؛ الصور الجديدة تُضاف للمعرض وتصبح أول صورة مرفوعة هي الصورة الرئيسية.

## 3.4 تعديل منتج

### `PUT /products/:id`

| Permission | `products.manage` |
| أسعار | قد تحتاج `products.price` |

أرسل الحقول المراد تعديلها فقط (partial update).

```http
PUT /api/v1/products/12
Authorization: Bearer <token>
Content-Type: application/json

{
  "price": 27900,
  "stock": 8,
  "status": "active",
  "is_featured": true
}
```

**ملاحظات:**

- تعديل `sku` يتحقق من عدم التكرار مع منتجات أخرى
- حقل `images` غير مدعوم في الـ PUT الحالي (يُرسل عند الإنشاء فقط)
- لتعديل المخزون مع سبب إلزامي استخدم أيضًا `/inventory/adjust`

## 3.5 حذف منتج (Admin)

### `DELETE /products/:id`

| Auth | Admin |
| Permission | `products.manage` |

#### حذف عادي (موصى به)

يخفي المنتج من المتجر (`status = archived`) ويحافظ على الطلبات القديمة.

```http
DELETE /api/v1/products/12
Authorization: Bearer <token>
```

```json
{
  "success": true,
  "data": {
    "message": "Product deleted",
    "id": 12,
    "permanent": false,
    "status": "archived"
  }
}
```

#### حذف نهائي

```http
DELETE /api/v1/products/12?permanent=true
Authorization: Bearer <token>
```

يُرفض بـ `400` لو المنتج موجود في طلبات أو تجميعات PC.

```js
await fetch(`http://localhost:8000/api/v1/products/${id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${token}` },
});
```

## 3.6 إضافة متغير (Variant)

مثل: RAM 16GB vs 32GB، أو ألوان مختلفة لنفس المنتج.

### `POST /products/:id/variants`

| Permission | `products.manage` |

| Field | Required | Description |
|-------|----------|-------------|
| `sku` | نعم | فريد على مستوى المنتجات والمتغيرات |
| `name` | نعم | اسم المتغير |
| `attributes` | لا | مثل `{ "capacity": "16GB", "color": "black" }` |
| `price` | لا | إن وُجد يتجاوز سعر المنتج الأب |
| `cost_price` | لا | |
| `stock` | لا | افتراضي 0 |
| `barcode` | لا | |
| `image` | لا | |
| `is_active` | لا | افتراضي true |

```http
POST /api/v1/products/20/variants
Authorization: Bearer <token>
Content-Type: application/json

{
  "sku": "RAM-CORSAIR-32-6000",
  "name": "32GB (2x16) DDR5-6000",
  "attributes": { "capacity_gb": 32, "speed_mhz": 6000, "modules": 2 },
  "price": 6200,
  "stock": 12,
  "is_active": true
}
```

---

# الجزء 4 — تعديل المخزون (مرتبط بإدارة المنتجات)

عند الحاجة لتعديل المخزون بسبب جرد / تلف / استلام بضاعة:

```http
POST /api/v1/inventory/adjust
Authorization: Bearer <token>
Content-Type: application/json

{
  "product_id": 12,
  "variant_id": null,
  "quantity_delta": 10,
  "reason": "استلام شحنة مورد #452"
}
```

| Permission | `inventory.manage` |
| `quantity_delta` | موجب = زيادة، سالب = نقص |
| `reason` | إلزامي (3 أحرف على الأقل) |

لا يُسمح بمخزون سالب.

---

# الجزء 5 — سير عمل مقترح في لوحة الأدمن

```text
1) Login كأدمن
2) أنشئ صنف / براند (مرة واحدة)
3) أضف منتج بـ FormData + صور من الجهاز → POST /products (multipart)
4) عدّل لاحقًا → PUT /products/:id (multipart)
```

---

# الجزء 6 — أكواد الأخطاء الشائعة

| Code | المعنى | مثال |
|------|--------|------|
| `400` | بيانات غير صالحة / قواعد عمل | علاقة دائرية، صنف فيه منتجات |
| `401` | غير مسجّل | بدون توكن |
| `403` | بدون صلاحية | ناقص `products.manage` |
| `404` | غير موجود | صنف/منتج خاطئ |
| `409` | تعارض | SKU مكرر |

---

# الجزء 7 — ملخص الـ Endpoints

### Categories

| Method | Path | Auth |
|--------|------|------|
| GET | `/categories` | عام |
| GET | `/categories?tree=true` | عام |
| GET | `/categories/:idOrSlug` | عام |
| POST | `/categories` | Admin |
| PUT | `/categories/:id` | Admin |
| DELETE | `/categories/:id` | Admin |

### Brands

| Method | Path | Auth |
|--------|------|------|
| GET | `/brands` | عام |
| GET | `/brands/:idOrSlug` | عام |
| POST | `/brands` | Admin |
| PUT | `/brands/:id` | Admin |
| DELETE | `/brands/:id` | Admin |

### Products

| Method | Path | Auth |
|--------|------|------|
| GET | `/products` | عام |
| GET | `/products/:idOrSlug` | عام |
| POST | `/products` | Admin |
| PUT | `/products/:id` | Admin |
| DELETE | `/products/:id` | Admin (أرشفة) |
| POST | `/products/:id/variants` | Admin |

### Inventory (مساعد)

| Method | Path | Auth |
|--------|------|------|
| POST | `/inventory/adjust` | Admin |
| GET | `/inventory/low-stock` | Admin |

---

# ملاحظات مهمة

1. **السعر من السيرفر دائمًا** — لا تعتمد على سعر مرسل من العميل عند الشراء؛ الكتالوج يعرض `effective_price`.
2. **SKU فريد** على المنتجات والمتغيرات معًا.
3. **الحذف الناعم للمنتجات** يحافظ على سلامة الطلبات القديمة.
4. **`specs`** مهمة لقطع التجميع؛ بدونها التوافق يكون `uncertain`.
5. القيم المالية تُخزَّن كـ `NUMERIC` وترجع كنصوص عشرية مثل `"28500.00"`.
