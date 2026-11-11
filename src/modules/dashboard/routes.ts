import { Router } from 'express';
import { z } from 'zod';
import pool from '../../db/pool';
import { asyncWrapper } from '../../utils';
import { authMiddleware, requirePermission } from '../../middleware/authentication';
import { ok } from '../../shared/response';

export const router = Router();

const Range = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

function dateFilter(from?: string, to?: string, alias = 'created_at') {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (from) {
    clauses.push(`${alias} >= $${i++}`);
    values.push(from);
  }
  if (to) {
    clauses.push(`${alias} <= $${i++}`);
    values.push(to);
  }
  return {
    sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '',
    values,
    next: i,
  };
}

router.get(
  '/overview',
  authMiddleware(['admin']),
  requirePermission('dashboard.read'),
  asyncWrapper(async (req, res) => {
    const { from, to } = Range.parse(req.query);
    const df = dateFilter(from, to);

    const revenue = await pool.query(
      `SELECT
         COALESCE(SUM(total),0) AS gross_sales,
         COALESCE(SUM(total - discount_total),0) AS net_sales,
         COALESCE(SUM(CASE WHEN payment_status IN ('paid','partially_refunded') THEN total ELSE 0 END),0) AS recognized_revenue,
         COUNT(*)::int AS orders_count,
         COALESCE(AVG(total),0) AS average_order_value
       FROM orders
       WHERE status NOT IN ('cancelled') ${df.sql.replace('created_at', 'created_at')}`,
      df.values,
    );

    const byStatus = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM orders
       WHERE 1=1 ${df.sql}
       GROUP BY status`,
      df.values,
    );

    const customers = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE role = 'user')::int AS total_customers,
         COUNT(*) FILTER (WHERE role = 'user' AND created_at >= COALESCE($1::timestamptz, NOW() - INTERVAL '30 days'))::int AS new_customers
       FROM users`,
      [from ?? null],
    );

    const lowStock = await pool.query(
      `SELECT COUNT(*)::int AS c FROM products
       WHERE track_inventory AND status = 'active'
         AND (stock - reserved_stock) <= low_stock_threshold`,
    );

    const outOfStock = await pool.query(
      `SELECT COUNT(*)::int AS c FROM products
       WHERE track_inventory AND status = 'active' AND (stock - reserved_stock) <= 0`,
    );

    const bestProducts = await pool.query(
      `SELECT oi.product_id, oi.product_name,
              SUM(oi.quantity)::int AS qty_sold,
              SUM(oi.line_total)::numeric AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status NOT IN ('cancelled') ${df.sql.replace(/created_at/g, 'o.created_at')}
         AND oi.product_id IS NOT NULL
       GROUP BY oi.product_id, oi.product_name
       ORDER BY qty_sold DESC
       LIMIT 10`,
      df.values,
    );

    const recentOrders = await pool.query(
      `SELECT id, order_number, status, payment_status, total, created_at
       FROM orders ORDER BY created_at DESC LIMIT 10`,
    );

    const builds = await pool.query(
      `SELECT COUNT(*)::int AS total_builds,
              COALESCE(AVG(subtotal),0) AS avg_build_value
       FROM pc_builds WHERE status <> 'archived'`,
    );

    const inventoryValue = await pool.query(
      `SELECT COALESCE(SUM(stock * COALESCE(cost_price, price)),0) AS inventory_valuation
       FROM products WHERE track_inventory = TRUE`,
    );

    ok(res, {
      definitions: {
        gross_sales: 'Sum of order totals excluding cancelled orders',
        net_sales: 'Gross sales minus discounts',
        recognized_revenue: 'Totals for orders with paid/partially_refunded payment status',
      },
      range: { from: from ?? null, to: to ?? null },
      sales: revenue.rows[0],
      orders_by_status: byStatus.rows,
      customers: customers.rows[0],
      inventory: {
        low_stock: lowStock.rows[0].c,
        out_of_stock: outOfStock.rows[0].c,
        valuation: inventoryValue.rows[0].inventory_valuation,
      },
      best_selling_products: bestProducts.rows,
      recent_orders: recentOrders.rows,
      custom_builds: builds.rows[0],
    });
  }),
);

router.get(
  '/sales-trend',
  authMiddleware(['admin']),
  requirePermission('dashboard.read'),
  asyncWrapper(async (req, res) => {
    const query = Range.extend({
      bucket: z.enum(['day', 'week', 'month', 'quarter', 'year']).default('day'),
    }).parse(req.query);

    const trunc = query.bucket;
    const df = dateFilter(query.from, query.to, 'created_at');
    const result = await pool.query(
      `SELECT date_trunc('${trunc}', created_at) AS period,
              COUNT(*)::int AS orders,
              COALESCE(SUM(total),0) AS sales
       FROM orders
       WHERE status NOT IN ('cancelled') ${df.sql}
       GROUP BY 1
       ORDER BY 1`,
      df.values,
    );
    ok(res, result.rows);
  }),
);
