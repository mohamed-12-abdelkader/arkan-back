import { runner } from 'node-pg-migrate';
import path from 'path';
import { config } from '../utils';
import pool, { buildPoolConfig } from './pool';
import bcrypt from 'bcrypt';

export async function applyMigrations(databaseUrl: string, direction: 'up' | 'down') {
  await runner({
    count: Number.POSITIVE_INFINITY,
    databaseUrl: buildPoolConfig(databaseUrl),
    dir: path.resolve(__dirname, '../../migrations'),
    direction,
    migrationsTable: 'migrations',
    verbose: false,
  });

  if (direction !== 'up') return;

  const { FIRST_SUPERUSER, FIRST_SUPERUSER_PASSWORD } = config;

  if (!FIRST_SUPERUSER || !FIRST_SUPERUSER_PASSWORD) return;

  const exists = await pool.query('SELECT id FROM users WHERE email = $1 OR phone = $1', [
    FIRST_SUPERUSER,
  ]);

  if (exists.rowCount === 0) {
    const hashed = await bcrypt.hash(FIRST_SUPERUSER_PASSWORD, 10);
    await pool.query(
      `INSERT INTO users (email, phone, password, name, role)
       VALUES (
         $1,
         CASE WHEN POSITION('@' IN $1) = 0 THEN $1 ELSE NULL END,
         $2,
         $1,
         'admin'
       )`,
      [FIRST_SUPERUSER, hashed],
    );
    console.log('✅ First superuser created.');
  } else {
    console.log('ℹ️  First superuser already exists.');
  }

  // Ensure admins have super_admin RBAC role when roles table exists
  try {
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id
       FROM users u
       CROSS JOIN roles r
       WHERE u.role = 'admin' AND r.slug = 'super_admin'
       ON CONFLICT DO NOTHING`,
    );
  } catch {
    // roles table may not exist yet on first boot before expansion migration
  }
}
