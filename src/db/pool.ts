import { Pool, PoolConfig } from 'pg';
import { config } from '../utils';

function buildPoolConfig(connectionString: string): PoolConfig {
  const needsSsl = /sslmode=/i.test(connectionString);
  const cleanedUrl = connectionString
    .replace(/([?&])sslmode=[^&]*/gi, '$1')
    .replace(/[?&]$/, '')
    .replace(/\?&/, '?');

  return {
    connectionString: cleanedUrl,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

const pool = new Pool(buildPoolConfig(config.DATABASE_URL));

export default pool;
export { buildPoolConfig };
