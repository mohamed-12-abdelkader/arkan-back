import pool from '../db/pool';

export async function getUserPermissionCodes(userId: number): Promise<Set<string>> {
  const result = await pool.query<{ code: string }>(
    `SELECT DISTINCT p.code
     FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = $1`,
    [userId],
  );

  // Legacy admin role still has full access
  const user = await pool.query<{ role: string; is_staff: boolean }>(
    'SELECT role, is_staff FROM users WHERE id = $1',
    [userId],
  );
  if (user.rows[0]?.role === 'admin') {
    const all = await pool.query<{ code: string }>('SELECT code FROM permissions');
    return new Set(all.rows.map((r) => r.code));
  }

  return new Set(result.rows.map((r) => r.code));
}

export async function userHasPermission(userId: number, code: string): Promise<boolean> {
  const codes = await getUserPermissionCodes(userId);
  return codes.has(code);
}
