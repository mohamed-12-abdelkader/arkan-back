import pool from '../db/pool';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { validate } from '../middleware/validateReq';
import { authMiddleware, requirePermission } from '../middleware/authentication';
import { Router } from 'express';
import { ChangePassword, RegisterUser } from './auth.modules';
import { asyncWrapper, HttpError, issueTokenPair } from '../utils';
import { UserRole } from '../db/types';
import { created, ok, paginated } from '../shared/response';
import { getOffset, PaginationQuery } from '../shared/pagination';
import { getUserPermissionCodes } from '../services/permissions';

const UpdateMe = z.object({
  email: z.string().email().optional(),
  phone: z
    .string()
    .regex(/^\+?[0-9]{8,15}$/, 'Invalid phone number')
    .optional(),
  password: z.string().min(6).optional(),
  name: z.string().min(1).optional(),
});

export const router = Router();

router.post(
  '/register',
  validate(RegisterUser),
  asyncWrapper(async (req, res) => {
    const { email, phone, password, name } = req.body;

    const existing = await pool.query(
      `SELECT id FROM users
       WHERE (email = $1 AND $1 IS NOT NULL) OR (phone = $2 AND $2 IS NOT NULL)`,
      [email ?? null, phone ?? null],
    );
    if (existing.rowCount) {
      throw new HttpError(409, 'Email or phone already registered');
    }

    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, phone, password, name, role, is_staff)
       VALUES ($1, $2, $3, $4, 'user', FALSE)
       RETURNING id, email, phone, name, role, avatar, is_staff, created_at`,
      [email ?? null, phone ?? null, hashed, name],
    );

    const user = result.rows[0];
    const tokens = await issueTokenPair(user, pool);
    created(res, {
      user,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token: tokens.accessToken,
    });
  }),
);

router.post(
  '/admin-change-password',
  authMiddleware(['admin']),
  requirePermission('customers.manage'),
  validate(ChangePassword),
  asyncWrapper(async (req, res) => {
    const { email, phone, new_password } = req.body;
    const query = email ? { field: 'email', value: email } : { field: 'phone', value: phone };
    const userResult = await pool.query(`SELECT id FROM users WHERE ${query.field} = $1`, [
      query.value,
    ]);
    if (!userResult.rowCount) throw new HttpError(404, 'User not found');
    const hashedPassword = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [
      hashedPassword,
      userResult.rows[0].id,
    ]);
    ok(res, { message: 'Password updated successfully' });
  }),
);

router.get(
  '/me',
  authMiddleware(),
  asyncWrapper(async (req, res) => {
    const permissions =
      req.user!.role === 'admin' || req.user!.is_staff
        ? [...(await getUserPermissionCodes(req.user!.id))]
        : [];
    ok(res, { user: { ...req.user, permissions } });
  }),
);

router.put(
  '/me',
  authMiddleware(),
  validate(UpdateMe),
  asyncWrapper(async (req, res) => {
    const { email, phone, password, name } = req.body;
    const userId = req.user!.id;
    if (email) await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, userId]);
    if (phone) await pool.query('UPDATE users SET phone = $1 WHERE id = $2', [phone, userId]);
    if (name) await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name, userId]);
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, userId]);
    }
    const updated = await pool.query(
      'SELECT id, email, phone, name, role, avatar, is_staff, created_at FROM users WHERE id = $1',
      [userId],
    );
    ok(res, { user: updated.rows[0] });
  }),
);

router.get(
  '/',
  authMiddleware(['admin']),
  requirePermission('customers.manage'),
  asyncWrapper(async (req, res) => {
    const query = PaginationQuery.extend({
      role: UserRole.optional(),
      status: z.enum(['active', 'suspended', 'deleted']).optional(),
    }).parse(req.query);

    const values: unknown[] = [];
    const where: string[] = [];
    let i = 1;
    if (query.role) {
      where.push(`role = $${i++}`);
      values.push(query.role);
    }
    if (query.status) {
      where.push(`status = $${i++}`);
      values.push(query.status);
    }
    if (query.q) {
      where.push(`(name ILIKE $${i} OR email ILIKE $${i} OR phone ILIKE $${i})`);
      values.push(`%${query.q}%`);
      i++;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM users ${whereSql}`, values);
    values.push(query.limit, getOffset(query.page, query.limit));
    const result = await pool.query(
      `SELECT id, name, email, phone, role, avatar, status, is_staff, created_at
       FROM users ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${i++} OFFSET $${i}`,
      values,
    );
    paginated(res, result.rows, {
      total: count.rows[0].total,
      page: query.page,
      limit: query.limit,
    });
  }),
);
