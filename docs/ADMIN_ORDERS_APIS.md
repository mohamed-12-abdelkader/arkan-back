# إدارة الطلبات (Admin Orders)

Base: `/api/v1/orders`  
صلاحيات: `orders.read` للعرض · `orders.manage` للتعديل

## القائمة

`GET /orders?page=&limit=&q=&status=&payment_status=&fulfillment_status=&from=&to=`

- بحث `q`: رقم الطلب / جوال / بريد / اسم العميل
- يعيد أيضاً: `customer_name`, `shipping_name`, `items_count`

## التفاصيل

`GET /orders/:id`

يشمل: العناصر، سجل الحالات، المدفوعات، و`allowed_next_statuses`

## تغيير الحالة

`PATCH /orders/:id/status`

```json
{ "status": "confirmed", "note": "تم التواصل مع العميل" }
```

الانتقالات المسموحة فقط (مثلاً `awaiting_confirmation` → `confirmed` | `cancelled`).  
عند بعض الحالات تُحدَّث تلقائياً `payment_status` / `fulfillment_status` (مثل `delivered` → مدفوع ومُسلَّم).

## تحديث بيانات الطلب

`PATCH /orders/:id`

```json
{
  "admin_notes": "يُفضّل الشحن مساءً",
  "payment_status": "paid",
  "fulfillment_status": "shipped",
  "phone": "01012345678"
}
```

## واجهة الفرونت

- قائمة: `/admin/orders`
- تفاصيل + تغيير الحالة: `/admin/orders/[id]`
