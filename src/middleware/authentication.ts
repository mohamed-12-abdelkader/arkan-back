import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../utils';
import pool from '../db/pool';
import { User } from '../db/types';
import { getUserPermissionCodes } from '../services/permissions';
import { fail } from '../shared/response';

export type AuthUser = User & {
  permissions?: string[];
};

export function authMiddleware(roles: Array<'user' | 'admin'> = []): RequestHandler {
  return async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return fail(res, 401, 'Unauthorized');

    try {
      const decoded = jwt.verify(token, config.SECRET_KEY) as {
        id: number;
        jti: string;
        typ?: string;
      };
      if (decoded.typ === 'refresh') return fail(res, 401, 'Invalid token type');

      const result = await pool.query<User>(
        `SELECT id, email, phone, name, role, avatar, jti, status, is_staff, created_at
         FROM users WHERE id = $1`,
        [decoded.id],
      );
      if (!result.rowCount) return fail(res, 401, 'User not found');

      const user = result.rows[0] as AuthUser;
      if ((user as any).status === 'suspended') return fail(res, 403, 'Account suspended');
      if ((user as any).status === 'deleted') return fail(res, 401, 'Account not found');

      if (roles.length && !roles.includes(user.role as 'user' | 'admin')) {
        return fail(res, 403, 'Forbidden: insufficient role');
      }

      if (user.jti && user.jti !== decoded.jti) {
        return fail(res, 401, 'Session expired or replaced');
      }

      if (user.role === 'admin' || (user as any).is_staff) {
        const perms = await getUserPermissionCodes(user.id);
        user.permissions = [...perms];
      }

      req.user = user;
      next();
    } catch {
      return fail(res, 401, 'Invalid token');
    }
  };
}

export function requirePermission(...codes: string[]): RequestHandler {
  return async (req, res, next) => {
    if (!req.user) return fail(res, 401, 'Unauthorized');
    if (req.user.role === 'admin') return next();

    const perms = new Set(req.user.permissions ?? (await getUserPermissionCodes(req.user.id)));
    const allowed = codes.some((c) => perms.has(c));
    if (!allowed) return fail(res, 403, 'Forbidden: missing permission');
    next();
  };
}

export function optionalAuth(): RequestHandler {
  return async (req, _res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return next();
    try {
      const decoded = jwt.verify(token, config.SECRET_KEY) as { id: number; jti: string };
      const result = await pool.query<User>(
        `SELECT id, email, phone, name, role, avatar, jti, status, is_staff, created_at
         FROM users WHERE id = $1`,
        [decoded.id],
      );
      if (result.rowCount) req.user = result.rows[0];
    } catch {
      // ignore
    }
    next();
  };
}
