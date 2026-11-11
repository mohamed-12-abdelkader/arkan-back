# أكواد الخصم (Coupons)

Base: `/api/v1`

## Admin (يتطلب `coupons.manage`)

| Method | Path | الوصف |
|--------|------|--------|
| GET | `/coupons?page=&limit=` | قائمة الأكواد |
| GET | `/coupons/:id` | تفاصيل كود |
| POST | `/coupons` | إنشاء كود |
| PUT | `/coupons/:id` | تحديث |
| DELETE | `/coupons/:id` | حذف |

### إنشاء كود (نسبة مئوية)

```json
{
  "code": "SAVE10",
  "value": 10,
  "type": "percentage",
  "min_order_amount": 200,
  "max_discount": 100,
  "usage_limit": 100,
  "per_customer_limit": 1,
  "is_active": true
}
```

- `type`: `percentage` (افتراضي) | `fixed` | `free_shipping`
- للنسبة: `value` من 1 إلى 100

## العميل قبل الدفع

| Method | Path | الوصف |
|--------|------|--------|
| POST | `/coupons/validate` | معاينة الخصم `{ code, subtotal }` |
| POST | `/cart/coupon` | تطبيق الكود على السلة `{ code, guest_token? }` |
| DELETE | `/cart/coupon` | إزالة الكود من السلة |
| POST | `/orders/checkout` | الدفع من السلة (يستخدم `cart.coupon_code`) |
| POST | `/orders/buy-now` | شراء مباشر مع `coupon_code` اختياري |

### validate

```json
POST /coupons/validate
{ "code": "SAVE10", "subtotal": 1500 }
```

## واجهة الفرونت

- أدمن: `/admin/coupons`
- سلة/دفع: حقل كود الخصم في `/checkout`
- اشترِ الآن: حقل كود في `/buy-now/[id]`
