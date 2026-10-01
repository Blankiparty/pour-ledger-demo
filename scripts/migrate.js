'use strict';

// Apply Drizzle migrations to DATABASE_URL. CI runs this against a clean
// postgres:16 service before Jest, so a broken migration fails loudly on its own step.
const { createDb } = require('../src/db/client');
const { runMigrations } = require('../src/db/migrate');

async function main() {
  const { pool, db } = createDb({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await runMigrations(db);
    const { rows } = await pool.query(
      "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
    );
    console.log(`migrations applied, ${rows[0].n} tables in public`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
