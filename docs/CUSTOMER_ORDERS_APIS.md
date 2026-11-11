# طلبات العملاء — ملخص سريع

> **التوثيق التفصيلي الكامل:**  
> [`CUSTOMER_COMMERCE_APIS.md`](./CUSTOMER_COMMERCE_APIS.md)

Base URL: `http://localhost:8000/api/v1`

| الحاجة | Endpoint |
|--------|----------|
| تسجيل (اسم + هاتف + باسورد) | `POST /user/register` |
| دخول | `POST /login` |
| سلة | `GET/POST /cart...` |
| طلب السلة | `POST /orders/checkout` |
| شراء منتج واحد | `POST /orders/buy-now` |
| تتبع (رقم + هاتف) | `GET /orders/track` |
| طلبات الحساب | `GET /orders/me` |

الدفع الحالي: `payment_method: "cod"`.
