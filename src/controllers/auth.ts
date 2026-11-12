import { Router } from 'express';
import pool from '../db/pool';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { asyncWrapper, config, issueTokenPair, sendEmail } from '../utils';
import { validate } from '../middleware/validateReq';
import {
  ChangeOwnPassword,
  ForgotPassword,
  Login,
  RefreshTokenSchema,
  ResetPassword,
} from './auth.modules';
import { rateLimit } from '../middleware/rateLimit';
import { authMiddleware } from '../middleware/authentication';
import { ok } from '../shared/response';
import { writeAudit } from '../services/audit';
import { getUserPermissionCodes } from '../services/permissions';
import { HttpError } from '../utils';

export const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  key: (req) => `login:${req.ip}:${req.body?.email || req.body?.phone || ''}`,
});

router.post(
  '/login',
  loginLimiter,
  validate(Login),
  asyncWrapper(async (req, res) => {
    const { email, phone, password } = req.body;

    const userQuery = email
      ? await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email])
      : await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);

    if (!userQuery.rowCount) {
      throw new HttpError(400, 'Invalid credentials');
    }

    const user = userQuery.rows[0];
    if (user.status === 'suspended') throw new HttpError(403, 'Account suspended');
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new HttpError(429, 'Account temporarily locked. Try again later.');
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      await pool.query(
        `UPDATE users SET failed_login_attempts = failed_login_attempts + 1,
         locked_until = CASE WHEN failed_login_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END
         WHERE id = $1`,
        [user.id],
      );
      throw new HttpError(400, 'Invalid credentials');
    }

    const tokens = await issueTokenPair(user, pool, req.headers['user-agent'] as string);
    const permissions =
      user.role === 'admin' || user.is_staff ? [...(await getUserPermissionCodes(user.id))] : [];

    await writeAudit({
      actorId: user.id,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    ok(res, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        is_staff: user.is_staff,
        permissions,
      },
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token: tokens.accessToken,
    });
  }),
);

router.post(
  '/refresh',
  validate(RefreshTokenSchema),
  asyncWrapper(async (req, res) => {
    const hash = crypto.createHash('sha256').update(req.body.refresh_token).digest('hex');
    const result = await pool.query(
      `SELECT rt.*, u.id AS uid, u.email, u.phone, u.name, u.role, u.is_staff, u.status
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()`,
      [hash],
    );
    if (!result.rowCount) throw new HttpError(401, 'Invalid refresh token');

    const row = result.rows[0];
    if (row.status === 'suspended') throw new HttpError(403, 'Account suspended');

    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [row.id]);

    const user = {
      id: row.uid,
      email: row.email,
      phone: row.phone,
      name: row.name,
      role: row.role,
      is_staff: row.is_staff,
    };
    const tokens = await issueTokenPair(user as any, pool, req.headers['user-agent'] as string);
    ok(res, {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token: tokens.accessToken,
    });
  }),
);

router.post(
  '/logout',
  authMiddleware(),
  asyncWrapper(async (req, res) => {
    const refresh = req.body?.refresh_token;
    if (refresh) {
      const hash = crypto.createHash('sha256').update(refresh).digest('hex');
      await pool.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND user_id = $2',
        [hash, req.user!.id],
      );
    } else {
      await pool.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
        [req.user!.id],
      );
    }
    await pool.query('UPDATE users SET jti = NULL WHERE id = $1', [req.user!.id]);
    ok(res, { message: 'Logged out' });
  }),
);

router.post(
  '/forgot-password',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }),
  validate(ForgotPassword),
  asyncWrapper(async (req, res) => {
    const { email } = req.body;
    const result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (result.rowCount) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query('INSERT INTO password_resets (user_id, token) VALUES ($1, $2)', [
        result.rows[0].id,
        token,
      ]);
      const resetLink = `${config.FRONTEND_HOST}/reset-password?token=${token}`;
      try {
        await sendEmail(
          email,
          'Password Reset',
          `<p>Click <a href="${resetLink}">here</a> to reset your password.</p>`,
        );
      } catch {
        // Don't leak email delivery failures
      }
    }
    ok(res, { message: 'If user exists, email was sent' });
  }),
);

router.post(
  '/reset-password',
  validate(ResetPassword),
  asyncWrapper(async (req, res) => {
    const { token, password } = req.body;
    const result = await pool.query(
      `SELECT user_id FROM password_resets
       WHERE token = $1 AND used = FALSE AND expires_at > NOW()`,
      [token],
    );
    if (!result.rowCount) throw new HttpError(400, 'Invalid or expired token');

    const userId = result.rows[0].user_id;
    const hashed = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = $1, jti = NULL WHERE id = $2', [hashed, userId]);
    await pool.query('UPDATE password_resets SET used = TRUE WHERE token = $1', [token]);
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    ok(res, { message: 'Password updated successfully' });
  }),
);

router.post(
  '/change-password',
  authMiddleware(),
  validate(ChangeOwnPassword),
  asyncWrapper(async (req, res) => {
    const { current_password, new_password } = req.body;
    const result = await pool.query('SELECT password FROM users WHERE id = $1', [req.user!.id]);
    const valid = await bcrypt.compare(current_password, result.rows[0].password);
    if (!valid) throw new HttpError(400, 'Current password is incorrect');

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.user!.id]);
    await writeAudit({
      actorId: req.user!.id,
      action: 'auth.change_password',
      resourceType: 'user',
      resourceId: req.user!.id,
    });
    ok(res, { message: 'Password changed successfully' });
  }),
);
