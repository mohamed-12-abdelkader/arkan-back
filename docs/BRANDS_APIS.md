# إدارة البراندات (Admin Brands APIs)

Base URL: `http://localhost:8000/api/v1`

عمليات الإضافة / التعديل / الحذف تحتاج:

```http
Authorization: Bearer <access_token>
```

| Permission | `brands.manage` |

---

## 1) قائمة البراندات

### `GET /brands`

عام — بدون Auth.

| Query | Description |
|-------|-------------|
| `page`, `limit` | ترقيم |
| `q` | بحث بالاسم أو الـ slug |
| `is_active` | `true` \| `false` |

```http
GET /api/v1/brands?page=1&limit=20&q=asus
```

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "ASUS",
      "slug": "asus",
      "description": null,
      "logo": "/uploads/brands/1710000000-logo.png",
      "website": "https://www.asus.com",
      "is_active": true
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

## 2) تفاصيل براند

### `GET /brands/:idOrSlug`

```http
GET /api/v1/brands/1
GET /api/v1/brands/asus
```

## 2.1) فلاتر صفحة البراند

### `GET /brands/:idOrSlug/filters`

عام — بدون Auth. يرجع التصنيفات اللي فيها منتجات لهذا البراند + أقل وأعلى سعر فعلي.

```http
GET /api/v1/brands/asus/filters
```

```json
{
  "success": true,
  "data": {
    "categories": [
      {
        "id": 3,
        "name": "لابات",
        "slug": "laptops",
        "image": null,
        "products_count": 4
      }
    ],
    "price": { "min": 12000, "max": 55000 }
  }
}
```

## 2.2) منتجات براند معيّن

### `GET /brands/:idOrSlug/products`

عام — بدون Auth. يرجع منتجات هذا البراند فقط (نشطة)، مع pagination افتراضي 12 منتج للصفحة.

| Query | Default | Description |
|-------|---------|-------------|
| `page` | `1` | رقم الصفحة |
| `limit` | `12` | عدد المنتجات (حد أقصى 100) |
| `q` | — | بحث بالاسم / SKU |
| `category_id` | — | فلتر تصنيف |
| `min_price` / `max_price` | — | نطاق السعر الفعلي |
| `in_stock` | — | `true` للمتوفر فقط |
| `featured` | — | `true` للمميزة فقط |
| `sort` | `created_at` | `price` \| `name` \| `created_at` \| `stock` |
| `order` | `desc` | `asc` \| `desc` |

```http
GET /api/v1/brands/asus/products?page=1&limit=12
GET /api/v1/brands/1/products?sort=price&order=asc&in_stock=true
```

```json
{
  "success": true,
  "data": [
    {
      "id": 10,
      "name": "لابتوب ASUS TUF 15",
      "slug": "asus-tuf-15",
      "price": "45000.00",
      "sale_price": null,
      "effective_price": "45000.00",
      "available_stock": 5,
      "brand_name": "ASUS",
      "category_name": "لابتوبات",
      "image": "/uploads/products/..."
    }
  ],
  "meta": { "total": 8, "page": 1, "limit": 12, "totalPages": 1 }
}
```

> لو البراند مش موجود → `404 Brand not found`.

---

## 3) إضافة براند

### `POST /brands`

| Auth | Admin |
| Content-Type | `multipart/form-data` |

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | text | **نعم** | اسم البراند |
| `description` | text | لا | وصف |
| `website` | text | لا | رابط الموقع |
| `is_active` | `true`/`false` | لا | افتراضي `true` |
| `logo` | file | لا | صورة اللوجو من الجهاز |

اللوجو يُحفظ في `uploads/brands` ويُعرض عبر:

`http://localhost:8000/uploads/brands/<filename>`

### مثال فرونت

```js
const form = new FormData();
form.append('name', 'ASUS');
form.append('description', 'ASUS hardware');
form.append('website', 'https://www.asus.com');
form.append('is_active', 'true');
if (logoInput.files[0]) form.append('logo', logoInput.files[0]);

await fetch('http://localhost:8000/api/v1/brands', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
```

### مثال cURL

```bash
curl -X POST http://localhost:8000/api/v1/brands \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=ASUS" \
  -F "description=ASUS hardware" \
  -F "website=https://www.asus.com" \
  -F "is_active=true" \
  -F "logo=@/path/to/asus-logo.png"
```

استجابة `201`:

```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "ASUS",
    "slug": "asus",
    "description": "ASUS hardware",
    "logo": "/uploads/brands/1710000000-asus-logo.png",
    "website": "https://www.asus.com",
    "is_active": true
  }
}
```

---

## 4) تعديل براند

### `PUT /brands/:id`

| Auth | Admin |
| Content-Type | `multipart/form-data` |

نفس حقول الإضافة — كلها اختيارية. أرسل ما تريد تغييره فقط.

```js
const form = new FormData();
form.append('name', 'ASUS ROG');
form.append('is_active', 'true');
if (logoInput.files[0]) form.append('logo', logoInput.files[0]);

await fetch(`http://localhost:8000/api/v1/brands/${id}`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
```

```bash
curl -X PUT http://localhost:8000/api/v1/brands/1 \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=ASUS ROG" \
  -F "logo=@/path/to/new-logo.png"
```

---

## 5) حذف براند

### `DELETE /brands/:id`

| Auth | Admin |

```http
DELETE /api/v1/brands/1
Authorization: Bearer <token>
```

- يتم فك ارتباط المنتجات أولًا (`brand_id = null`) ثم حذف البراند
- المنتجات نفسها **لا تُحذف**

```json
{
  "success": true,
  "data": { "message": "Brand deleted", "id": 1 }
}
```

---

## ملخص

| Method | Path | Auth | الوصف |
|--------|------|------|--------|
| GET | `/brands` | عام | قائمة |
| GET | `/brands/:idOrSlug` | عام | تفاصيل |
| GET | `/brands/:idOrSlug/filters` | عام | فلاتر صفحة البراند |
| GET | `/brands/:idOrSlug/products` | عام | منتجات البراند فقط |
| POST | `/brands` | Admin | إضافة (+ لوجو اختياري) |
| PUT | `/brands/:id` | Admin | تعديل |
| DELETE | `/brands/:id` | Admin | حذف |

## أخطاء شائعة

| Code | المعنى |
|------|--------|
| `400` | بيانات غير صالحة / فشل رفع الصورة |
| `401` | بدون توكن |
| `403` | بدون صلاحية `brands.manage` |
| `404` | البراند غير موجود |
