import { Router } from 'express';
import { z } from 'zod';
import pool from '../../db/pool';
import { asyncWrapper, HttpError } from '../../utils';
import { authMiddleware, requirePermission } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { ok } from '../../shared/response';
import { writeAudit } from '../../services/audit';

export const router = Router();

router.get(
  '/',
  authMiddleware(['admin']),
  requirePermission('roles.manage'),
  asyncWrapper(async (_req, res) => {
    const roles = await pool.query('SELECT * FROM roles ORDER BY id');
    const perms = await pool.query(
      `SELECT rp.role_id, p.code, p.module, p.description
       FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id`,
    );
    ok(
      res,
      roles.rows.map((r) => ({
        ...r,
        permissions: perms.rows.filter((p) => p.role_id === r.id).map((p) => p.code),
      })),
    );
  }),
);

router.get(
  '/permissions',
  authMiddleware(['admin']),
  requirePermission('roles.manage'),
  asyncWrapper(async (_req, res) => {
    const result = await pool.query('SELECT * FROM permissions ORDER BY module, code');
    ok(res, result.rows);
  }),
);

router.put(
  '/users/:userId',
  authMiddleware(['admin']),
  requirePermission('roles.manage'),
  validate(z.object({ role_slugs: z.array(z.string()).min(1) })),
  asyncWrapper(async (req, res) => {
    const userId = Number(req.params.userId);
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user.rowCount) throw new HttpError(404, 'User not found');

    const roles = await pool.query('SELECT * FROM roles WHERE slug = ANY($1::text[])', [
      req.body.role_slugs,
    ]);
    if (roles.rowCount !== req.body.role_slugs.length) {
      throw new HttpError(400, 'One or more roles not found');
    }

    // Prevent removing last super_admin
    if (!req.body.role_slugs.includes('super_admin')) {
      const current = await pool.query(
        `SELECT ur.user_id FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE r.slug = 'super_admin'`,
      );
      const onlyThis = current.rowCount === 1 && Number(current.rows[0].user_id) === userId;
      if (onlyThis) {
        throw new HttpError(400, 'Cannot remove the last Super Admin');
      }
    }

    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    for (const role of roles.rows) {
      await pool.query('INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1,$2,$3)', [
        userId,
        role.id,
        req.user!.id,
      ]);
    }

    await pool.query('UPDATE users SET is_staff = TRUE, role = $1 WHERE id = $2', [
      req.body.role_slugs.includes('super_admin') ? 'admin' : 'admin',
      userId,
    ]);

    await writeAudit({
      actorId: req.user!.id,
      action: 'roles.assign',
      resourceType: 'user',
      resourceId: userId,
      after: { role_slugs: req.body.role_slugs },
    });

    ok(res, { user_id: userId, role_slugs: req.body.role_slugs });
  }),
);
