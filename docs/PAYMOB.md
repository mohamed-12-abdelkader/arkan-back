# Paymob (KSA)

عقد الـ APIs للفرونت: [ELECTRONIC_PAYMENT_APIS.md](./ELECTRONIC_PAYMENT_APIS.md).

المفاتيح في `.env` فقط (`PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY`, `PAYMOB_HMAC`, `PAYMOB_API_KEY`).  
الحساب الحالي مفاتيحه `sau_*` لذلك البوابة `https://ksa.paymob.com` والعملة `SAR`.

الدفع يستخدم `PAYMOB_INTEGRATION_ID` الرقمي (من Dashboard → Payment Integrations) ورابط:

`https://ksa.paymob.com/unifiedcheckout/?publicKey=...&clientSecret=...`

مفتاح الاختبار يعمل فقط مع Integration تجريبي. ضع رقمه في `PAYMOB_INTEGRATION_ID`.

## التدفق

1. العميل يختار `payment_method: "card"` في `POST /orders/checkout` أو `POST /orders/buy-now`.
2. يُنشأ الطلب بحالة `pending_payment`.
3. السيرفر ينشئ Intention ويرجع `checkout_url`.
4. المتصفح يتحول لصفحة Paymob.
5. بعد الدفع: `GET /payments/paymob/return` يتحقق من HMAC ثم يحوّل إلى `/checkout/result`.
6. عند النجاح: `payment_status = paid` والحالة `awaiting_confirmation`.

Webhook (يحتاج رابط عام): `POST /api/v1/payments/paymob/webhook`  
ضعه في `PAYMOB_NOTIFICATION_URL`.

إعادة محاولة الدفع: `POST /payments/paymob/session` `{ "order_number": "ARK-..." }`.
