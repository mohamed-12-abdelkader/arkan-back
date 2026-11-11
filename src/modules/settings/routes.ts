import { Router } from 'express';
import { z } from 'zod';
import pool from '../../db/pool';
import { asyncWrapper, HttpError } from '../../utils';
import { authMiddleware, requirePermission } from '../../middleware/authentication';
import { validate } from '../../middleware/validateReq';
import { ok } from '../../shared/response';
import { writeAudit } from '../../services/audit';

export const router = Router();

const PUBLIC_KEYS = new Set([
  'currency',
  'timezone',
  'store_name',
  'tax_rate',
  'assistant_config',
]);

router.get(
  '/public',
  asyncWrapper(async (_req, res) => {
    const result = await pool.query(
      `SELECT key, value FROM store_settings WHERE key = ANY($1::text[])`,
      [[...PUBLIC_KEYS]],
    );
    const settings: Record<string, unknown> = {};
    for (const row of result.rows) settings[row.key] = row.value;
    ok(res, settings);
  }),
);

router.get(
  '/',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  asyncWrapper(async (_req, res) => {
    const result = await pool.query('SELECT key, value, updated_at FROM store_settings ORDER BY key');
    const settings: Record<string, unknown> = {};
    for (const row of result.rows) settings[row.key] = row.value;
    ok(res, settings);
  }),
);

router.put(
  '/',
  authMiddleware(['admin']),
  requirePermission('settings.manage'),
  validate(z.record(z.any())),
  asyncWrapper(async (req, res) => {
    const entries = Object.entries(req.body);
    if (!entries.length) throw new HttpError(400, 'No settings provided');

    // Never accept secrets via this endpoint
    for (const [key] of entries) {
      if (/secret|password|api_key|token/i.test(key)) {
        throw new HttpError(400, `Refusing to store sensitive key: ${key}`);
      }
    }

    for (const [key, value] of entries) {
      await pool.query(
        `INSERT INTO store_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(value)],
      );
    }

    await writeAudit({
      actorId: req.user!.id,
      action: 'settings.update',
      resourceType: 'store_settings',
      after: req.body,
    });

    const result = await pool.query('SELECT key, value FROM store_settings');
    const settings: Record<string, unknown> = {};
    for (const row of result.rows) settings[row.key] = row.value;
    ok(res, settings);
  }),
);
