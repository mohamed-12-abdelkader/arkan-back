# WhatsApp Order Confirmation (glassShop-compatible)

نظام متابعة الطلبات عبر واتساب مطابق لسلوك **glassShop / جفون**:

1. الطلب يُنشأ بحالة `pending` (أو `pending_payment` لـ Paymob)
2. يُرسل ملخص الطلب على واتساب
3. **فقط عند نجاح الإرسال** تصبح الحالة `awaiting_confirmation`
4. رد العميل «نعم» → `confirmed` / «لا» → `cancelled`
5. لو فشل الإرسال يبقى الطلب `pending` للتأكيد اليدوي

## Environment

```env
WHATSAPP_GATEWAY_URL=https://your-wa-gateway.example
WHATSAPP_API_KEY=...
WHATSAPP_WEBHOOK_SECRET=...
DEEPSEEK_API_KEY=...
```

Webhook للبوابة:

```text
POST {API}/api/v1/webhooks/whatsapp
```

## Admin APIs

نفس مسارات glassShop تحت `/whatsapp`، مع aliases إضافية لـ Arkan:

| Method | Path | Body / Notes |
|--------|------|----------------|
| GET | `/whatsapp/status` | `configured`, `orderConfirmSessionId`, `order_confirm_session_id` |
| GET | `/whatsapp/sessions` | sessions + assigned session ids |
| POST | `/whatsapp/sessions` | `{ id }` |
| GET | `/whatsapp/sessions/:id` | status + QR |
| POST | `/whatsapp/sessions/:id/reconnect` | `{}` |
| DELETE | `/whatsapp/sessions/:id` | |
| PUT | `/whatsapp/settings` | `{ orderConfirmSessionId }` أو `{ order_confirm_session_id }` |
| POST | `/whatsapp/orders/:id/resend-confirm` | يعيد الإرسال ويضبط الحالة مثل glassShop |

كل الردود داخل `{ success: true, data: ... }` حسب بنية أركان.

## Webhook

`POST /webhooks/whatsapp` — نفس منطق glassShop (توقيع HMAC، تصنيف DeepSeek، تأكيد/إلغاء، ردود عربية).
