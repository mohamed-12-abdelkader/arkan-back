import pool from '../src/db/pool';

async function main() {
  await pool.query('ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL');
  const r = await pool.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'orders' AND column_name = 'user_id'`,
  );
  console.log('orders.user_id is_nullable =', r.rows[0]?.is_nullable);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
