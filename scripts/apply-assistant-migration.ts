import fs from 'node:fs';
import path from 'node:path';
import pool from '../src/db/pool';

async function main() {
  const file = path.join(process.cwd(), 'migrations', '1762200000000_assistant-chat.sql');
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const sql = raw.split('-- Down Migration')[0];
  await pool.query(sql);

  await pool.query(
    `CREATE TABLE IF NOT EXISTS migrations (
       id SERIAL PRIMARY KEY,
       name VARCHAR(255) NOT NULL,
       run_on TIMESTAMP NOT NULL
     )`,
  );
  await pool.query(
    `INSERT INTO migrations (name, run_on)
     SELECT '1762200000000_assistant-chat', NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM migrations WHERE name = '1762200000000_assistant-chat'
     )`,
  );

  const check = await pool.query(
    `SELECT to_regclass('public.assistant_conversations') AS table_name,
            (SELECT COUNT(*)::int FROM migrations WHERE name = '1762200000000_assistant-chat') AS marked`,
  );
  console.log('assistant migration applied', check.rows[0]);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
