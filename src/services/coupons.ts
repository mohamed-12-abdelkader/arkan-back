import pool from '../db/pool';
import { HttpError } from '../utils';
import { percentOf, toMoney } from '../shared/money';

export type CouponRow = {
  id: number;
  code: string;
  type: 'fixed' | 'percentage' | 'free_shipping';
  value: string | number;
  min_order_amount: string | number | null;
  max_discount: string | number | null;
  starts_at: string | Date | null;
  ends_at: string | Date | null;
  usage_limit: number | null;
  per_customer_limit: number | null;
  used_count: number;
  first_order_only: boolean;
  is_active: boolean;
};

export async function findActiveCoupon(code: string): Promise<CouponRow> {
  const result = await pool.query(
    `SELECT * FROM coupons WHERE UPPER(code) = UPPER($1) AND is_active = TRUE`,
    [code.trim()],
  );
  if (!result.rowCount) throw new HttpError(400, 'كود الخصم غير صالح');
  return result.rows[0];
}

/** Validate coupon against order subtotal (and optional user). Returns discount amount. */
export async function validateCouponForAmount(
  code: string,
  subtotal: string | number,
  userId?: number | null,
): Promise<{ coupon: CouponRow; discount: string }> {
  const coupon = await findActiveCoupon(code);
  const now = Date.now();

  if (coupon.starts_at && new Date(coupon.starts_at).getTime() > now) {
    throw new HttpError(400, 'كود الخصم لم يبدأ بعد');
  }
  if (coupon.ends_at && new Date(coupon.ends_at).getTime() < now) {
    throw new HttpError(400, 'كود الخصم منتهي الصلاحية');
  }
  if (coupon.usage_limit != null && Number(coupon.used_count) >= Number(coupon.usage_limit)) {
    throw new HttpError(400, 'تم استنفاذ مرات استخدام هذا الكود');
  }

  const sub = Number(subtotal);
  if (coupon.min_order_amount != null && sub < Number(coupon.min_order_amount)) {
    throw new HttpError(
      400,
      `الحد الأدنى للطلب لتطبيق الكود هو ${toMoney(coupon.min_order_amount)} ج.م`,
    );
  }

  if (userId && coupon.per_customer_limit != null) {
    const used = await pool.query(
      `SELECT COUNT(*)::int AS c FROM coupon_redemptions
       WHERE coupon_id = $1 AND user_id = $2`,
      [coupon.id, userId],
    );
    if (used.rows[0].c >= Number(coupon.per_customer_limit)) {
      throw new HttpError(400, 'وصلت للحد الأقصى لاستخدام هذا الكود');
    }
  }

  if (coupon.first_order_only && userId) {
    const orders = await pool.query(
      `SELECT COUNT(*)::int AS c FROM orders
       WHERE user_id = $1 AND status NOT IN ('cancelled')`,
      [userId],
    );
    if (orders.rows[0].c > 0) {
      throw new HttpError(400, 'هذا الكود لأول طلب فقط');
    }
  }

  let discount = '0.00';
  if (coupon.type === 'percentage') {
    const pct = Math.min(100, Math.max(0, Number(coupon.value)));
    discount = percentOf(sub, pct);
    if (coupon.max_discount != null) {
      discount = toMoney(Math.min(Number(discount), Number(coupon.max_discount)));
    }
  } else if (coupon.type === 'fixed') {
    discount = toMoney(Math.min(Number(coupon.value), sub));
  } else if (coupon.type === 'free_shipping') {
    discount = '0.00';
  }

  return { coupon, discount };
}
