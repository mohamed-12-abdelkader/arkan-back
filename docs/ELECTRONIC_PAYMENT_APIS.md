# الدفع الإلكتروني — عقد الفرونت

Base: `http://localhost:8000/api/v1`

الرد الناجح:

```json
{ "success": true, "data": {} }
```

الخطأ:

```json
{ "success": false, "message": "..." }
```

الفرونت لا يرسل مفاتيح Paymob ولا يبني رابط الدفع. السيرفر يرجع `checkoutUrl` والمتصفح يتحول إليه.

حساب الدفع هو حساب المتجر على Paymob، منفصل عن أي متجر آخر.

---

## طرق الدفع

أرسل واحدة من هذه القيم في `payment_method`:

| القيمة | النتيجة |
|---|---|
| `cod` أو `cash_on_delivery` | طلب عادي. `paymentMethod` في الرد = `cash_on_delivery`. لا يوجد رابط دفع. الحالة `awaiting_confirmation`. |
| `card` أو `paymob` | طلب ثم جلسة Paymob. `paymentMethod` = `paymob`. الحالة `pending_payment` إلى أن ينجح الدفع. |
| `tamara` | طلب ثم جلسة تمارا. `paymentMethod` = `tamara`. الحالة `pending_payment` إلى أن يُعتمد الدفع. |
| `bank_transfer` | طلب بانتظار التأكيد، بدون رابط دفع. |

الواجهة تعرض: **الدفع عند الاستلام** و **Paymob** و **تمارا**.

لو الطريقة `paymob` و `PAYMOB_INTEGRATION_ID` غير موجود على السيرفر، الطلب لا يُنشأ ويرجع `500`.  
لو الطريقة `tamara` و `TAMARA_API_TOKEN` فارغ، الطلب لا يُنشأ ويرجع `500`.  
تفاصيل تمارا: [TAMARA.md](./TAMARA.md).

---

## 1. إتمام السلة

`POST /orders/checkout`

المصادقة اختيارية. الضيف يرسل `guest_token` القادم من السلة. المستخدم المسجّل يرسل `Authorization: Bearer <token>`.

كود الخصم يتطبّق قبل ذلك على السلة عبر `POST /cart/coupon`، وليس داخل هذا الطلب.

```json
{
  "guest_token": "optional",
  "guest_email": "user@example.com",
  "phone": "01012345678",
  "payment_method": "paymob",
  "customer_notes": "اختياري",
  "shipping_address": {
    "full_name": "أحمد علي",
    "phone": "01012345678",
    "city": "القاهرة",
    "address_line1": "الشارع، المبنى"
  }
}
```

`201` عند الاستلام:

```json
{
  "success": true,
  "data": {
    "id": 41,
    "order_number": "ARK-20261026-123456",
    "status": "awaiting_confirmation",
    "payment_status": "pending",
    "total": "1500.00",
    "phone": "01012345678",
    "paymentMethod": "cash_on_delivery",
    "checkoutUrl": null,
    "checkout_url": null,
    "clientSecret": null,
    "paymentToken": null,
    "paymentError": null
  }
}
```

`201` مع Paymob:

```json
{
  "success": true,
  "data": {
    "id": 41,
    "order_number": "ARK-20261026-123456",
    "status": "pending_payment",
    "payment_status": "pending",
    "total": "1500.00",
    "paymentMethod": "paymob",
    "checkoutUrl": "https://ksa.paymob.com/unifiedcheckout/?publicKey=...&clientSecret=...",
    "checkout_url": "https://ksa.paymob.com/unifiedcheckout/?publicKey=...&clientSecret=...",
    "clientSecret": "...",
    "paymentToken": "...",
    "paymentError": null
  }
}
```

`201` والطلب اتعمل لكن Paymob رفض الجلسة:

```json
{
  "success": true,
  "data": {
    "order_number": "ARK-20261026-123456",
    "status": "pending_payment",
    "paymentMethod": "paymob",
    "checkoutUrl": null,
    "checkout_url": null,
    "paymentError": "رسالة الخطأ",
    "payment_error": "رسالة الخطأ"
  }
}
```

إنشاء الطلب من السلة يفرّغ السلة حتى لو الدفع لم يكتمل.

### سلوك الواجهة

1. احفظ `order_number` و`phone` في `sessionStorage` قبل أي تحويل.
2. لو `checkoutUrl` أو `checkout_url` موجود: `window.location.href = checkoutUrl`.
3. لو `paymentError`: اعرض الرسالة مع رقم الطلب، وأظهر زر إعادة الدفع (القسم 3). لا تفتح صفحة النجاح.
4. لو الطريقة عند الاستلام: وجّه المستخدم لتتبع الطلب.

`clientSecret` و`paymentToken` للعرض أو إعادة فتح نفس الجلسة. لا تُخزَّن كمفاتيح دائمة.

---

## 2. اشترِ الآن

`POST /orders/buy-now`

نفس بيانات القسم 1، بالإضافة للمنتج. لا يستخدم السلة ولا يفرّغها.

```json
{
  "product_id": 12,
  "quantity": 1,
  "variant_id": null,
  "coupon_code": "SAVE10",
  "phone": "01012345678",
  "payment_method": "paymob",
  "shipping_address": {
    "full_name": "أحمد علي",
    "phone": "01012345678",
    "city": "القاهرة",
    "address_line1": "الشارع، المبنى"
  }
}
```

`coupon_code` اختياري. الرد ومعاملة `checkoutUrl` مثل القسم 1.

---

## 3. إعادة الدفع

`POST /payments/paymob/session` — Paymob فقط  
`POST /payments/tamara/session` — تمارا فقط  
`POST /payments/session` — يختار المزوّد حسب سجل الدفع على الطلب

لطلب حالته `pending_payment` أو ظهر له `paymentError`.

```json
{
  "order_number": "ARK-20261026-123456",
  "phone": "01012345678"
}
```

`phone` اختياري. لو اتبعت يجب أن يطابق جوال الطلب.

`201`:

```json
{
  "success": true,
  "data": {
    "order_number": "ARK-20261026-123456",
    "checkoutUrl": "https://...",
    "checkout_url": "https://...",
    "clientSecret": "...",
    "paymentToken": "...",
    "payment_provider": "paymob"
  }
}
```

| الحالة | المعنى |
|---|---|
| `400` | الطلب مدفوع بالفعل |
| `403` | الجوال لا يطابق الطلب |
| `404` | رقم الطلب غير موجود |
| `500` | إعدادات المزوّد ناقصة |
| `503` | مفاتيح الدفع غير مُعدّة |

بعد النجاح حوّل المتصفح إلى `checkoutUrl`.

Webhook تمارا: `POST /payments/tamara/webhook?tamaraToken=...`  
رجوع تمارا: `/payments/tamara/return/success|failure|cancel` — انظر [TAMARA.md](./TAMARA.md).

---

## 4. الرجوع من Paymob

بعد الدفع، Paymob يفتح المتصفح على:

`http://localhost:3000/checkout/result`

ويضيف باراميترات المعاملة، أهمها:

| الباراميتر | المعنى |
|---|---|
| `success` | `true` أو `false` |
| `pending` | `true` لو العملية لم تُحسم |
| `merchant_order_id` | مرجع داخلي شكله `order-{id}-...` وليس رقم `ARK-...` |
| `id` | رقم عملية Paymob |

لا تعتمد على `merchant_order_id` لعرض رقم الطلب. استخدم `order_number` الذي حفظته قبل التحويل.

صفحة `/checkout/result`:

- `success=true` و`pending` ليست `true`: اعرض نجاح الدفع، ثم أكّد من السيرفر.
- غير ذلك: اعرض أن الدفع لم يكتمل، مع زر `POST /payments/paymob/session`.

التأكيد:

`GET /orders/track?order_number=ARK-...&phone=01012345678`

بعد الدفع الناجح:

| الحقل | القيمة |
|---|---|
| `status` | `awaiting_confirmation` |
| `payment_status` | `paid` |

قبل الدفع أو عند الفشل:

| الحقل | القيمة |
|---|---|
| `status` | `pending_payment` |
| `payment_status` | `pending` أو `failed` |

للمستخدم المسجّل نفس الحقول في `GET /orders/me` و`GET /orders/me/:id`.

---

## 5. لا تستدعِه من الواجهة

`POST /payments/paymob/webhook`  
استدعاء من Paymob إلى السيرفر فقط.

`GET /payments/paymob/return`  
مسار السيرفر لو حوّلت إعداد الرجوع إليه. الإعداد الحالي يرجّع المتصفح مباشرة إلى `/checkout/result`.

---

## تسلسل الواجهة

```text
اختيار Paymob أو الدفع عند الاستلام
  -> POST /orders/checkout أو POST /orders/buy-now
  -> احفظ order_number + phone
  -> checkoutUrl موجود؟ حوّل المتصفح
  -> paymentError؟ اعرضه مع زر إعادة الدفع
  -> عند الاستلام؟ افتح التتبع

الرجوع إلى /checkout/result
  -> اقرأ success من رابط Paymob
  -> GET /orders/track للتأكد أن payment_status = paid
```
