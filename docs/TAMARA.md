# Tamara (BNPL)

عقد الـ APIs للفرونت: [ELECTRONIC_PAYMENT_APIS.md](./ELECTRONIC_PAYMENT_APIS.md)  
التوثيق الرسمي: https://docs.tamara.co/

المفاتيح في `.env` فقط — اتركها فارغة حتى يصلك حساب التاجر من تمارا:

| المتغير | المصدر |
|---|---|
| `TAMARA_API_TOKEN` | Partners Portal / إيميل تمارا — Bearer لكل طلب API |
| `TAMARA_NOTIFICATION_TOKEN` | للتحقق من JWT الـ webhook (`tamaraToken`) |
| `TAMARA_PUBLIC_KEY` | للويدجت (اختياري حالياً) |
| `TAMARA_API_URL` | Sandbox: `https://api-sandbox.tamara.co` — Live: `https://api.tamara.co` |
| `TAMARA_COUNTRY_CODE` | `SA` / `AE` / … |
| `TAMARA_CURRENCY` | `SAR` / `AED` / … |
| `TAMARA_PAYMENT_TYPE` | افتراضي `PAY_BY_INSTALMENTS` |
| `TAMARA_INSTALMENTS` | افتراضي `3` |
| `TAMARA_LOCALE` | افتراضي `ar_SA` |
| `TAMARA_SUCCESS_URL` / `FAILURE` / `CANCEL` | اتركها فارغة لاستخدام مسارات الباكند |

## التدفق

1. العميل يختار `payment_method: "tamara"` في `POST /orders/checkout` أو `POST /orders/buy-now`.
2. يُنشأ الطلب بحالة `pending_payment`.
3. السيرفر يستدعي `POST {TAMARA_API_URL}/checkout` ويرجع `checkout_url`.
4. المتصفح يتحول لصفحة تمارا.
5. Webhook: `POST /api/v1/payments/tamara/webhook?tamaraToken=...`  
   عند `order_approved` يتم `POST /orders/{id}/authorise` ثم اعتبار الطلب مدفوعاً (`payment_status = paid`).
6. الرجوع للمتجر عبر:
   - `GET /api/v1/payments/tamara/return/success`
   - `GET /api/v1/payments/tamara/return/failure`
   - `GET /api/v1/payments/tamara/return/cancel`
7. عند تغيير حالة الطلب إلى `shipped` يُستدعى Capture تلقائياً.

## إعداد Webhook في بوابة تمارا

URL (HTTPS عام):

`https://YOUR_API_HOST/api/v1/payments/tamara/webhook`

فعّل أحداث: `order_approved`, `order_declined`, `order_authorised`, `order_canceled`, `order_captured`, `order_expired`.

## إعادة محاولة الدفع

`POST /payments/tamara/session` أو الموحد `POST /payments/session`  
Body: `{ "order_number": "ARK-...", "phone": "..." }`
