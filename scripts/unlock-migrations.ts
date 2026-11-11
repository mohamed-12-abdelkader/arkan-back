import pool from '../src/db/pool';

async function main() {
  await pool.query('SELECT pg_advisory_unlock_all()');
  console.log('advisory locks unlocked');
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
