import pool from '../db/pool';

export async function writeAudit(params: {
  actorId?: number | null;
  action: string;
  resourceType: string;
  resourceId?: string | number | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}) {
  await pool.query(
    `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, before_data, after_data, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.actorId ?? null,
      params.action,
      params.resourceType,
      params.resourceId != null ? String(params.resourceId) : null,
      params.before ? JSON.stringify(params.before) : null,
      params.after ? JSON.stringify(params.after) : null,
      params.ip ?? null,
      params.userAgent ?? null,
    ],
  );
}
