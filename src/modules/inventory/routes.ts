import { Router } from 'express';
import { z } from 'zod';
import pool from '../../db/pool';
import { asyncWrapper, HttpError } from '../../utils';
import { authMiddleware, requirePermission } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { ok, paginated } from '../../shared/response';
import { getOffset, PaginationQuery } from '../../shared/pagination';
import { withTransaction } from '../../shared/db';
import { writeAudit } from '../../services/audit';

export const router = Router();

router.get(
  '/low-stock',
  authMiddleware(['admin']),
  requirePermission('inventory.manage'),
  asyncWrapper(async (_req, res) => {
    const result = await pool.query(
      `SELECT id, name, sku, stock, reserved_stock, low_stock_threshold,
              (stock - reserved_stock) AS available
       FROM products
       WHERE track_inventory = TRUE
         AND status = 'active'
         AND (stock - reserved_stock) <= low_stock_threshold
       ORDER BY available ASC`,
    );
    ok(res, result.rows);
  }),
);

router.get(
  '/movements',
  authMiddleware(['admin']),
  requirePermission('inventory.manage'),
  asyncWrapper(async (req, res) => {
    const query = PaginationQuery.extend({
      product_id: z.coerce.number().optional(),
    }).parse(req.query);
    const values: unknown[] = [];
    let where = '';
    if (query.product_id) {
      where = 'WHERE product_id = $1';
      values.push(query.product_id);
    }
    const count = await pool.query(
      `SELECT COUNT(*)::int AS total FROM stock_movements ${where}`,
      values,
    );
    const i = values.length + 1;
    values.push(query.limit, getOffset(query.page, query.limit));
    const result = await pool.query(
      `SELECT * FROM stock_movements ${where}
       ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      values,
    );
    paginated(res, result.rows, {
      total: count.rows[0].total,
      page: query.page,
      limit: query.limit,
    });
  }),
);

router.post(
  '/adjust',
  authMiddleware(['admin']),
  requirePermission('inventory.manage'),
  validate(
    z.object({
      product_id: z.number().int().positive(),
      variant_id: z.number().int().positive().optional().nullable(),
      quantity_delta: z.number().int(),
      reason: z.string().min(3),
    }),
  ),
  asyncWrapper(async (req, res) => {
    const { product_id, variant_id, quantity_delta, reason } = req.body;
    if (quantity_delta === 0) throw new HttpError(400, 'quantity_delta cannot be zero');

    const updated = await withTransaction(async (client) => {
      const product = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [
        product_id,
      ]);
      if (!product.rowCount) throw new HttpError(404, 'Product not found');

      const newStock = Number(product.rows[0].stock) + quantity_delta;
      if (newStock < 0) throw new HttpError(400, 'Stock cannot be negative');

      const result = await client.query(
        `UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [newStock, product_id],
      );

      if (variant_id) {
        const v = await client.query(
          `UPDATE product_variants SET stock = stock + $1, updated_at = NOW()
           WHERE id = $2 AND product_id = $3 RETURNING *`,
          [quantity_delta, variant_id, product_id],
        );
        if (!v.rowCount) throw new HttpError(404, 'Variant not found');
        if (Number(v.rows[0].stock) < 0)
          throw new HttpError(400, 'Variant stock cannot be negative');
      }

      await client.query(
        `INSERT INTO stock_movements
         (product_id, variant_id, movement_type, quantity, reason, reference_type, actor_id)
         VALUES ($1,$2,'adjustment',$3,$4,'manual',$5)`,
        [product_id, variant_id ?? null, quantity_delta, reason, req.user!.id],
      );

      return result.rows[0];
    });

    await writeAudit({
      actorId: req.user!.id,
      action: 'inventory.adjust',
      resourceType: 'product',
      resourceId: product_id,
      after: { quantity_delta, reason, stock: updated.stock },
    });

    ok(res, updated);
  }),
);
