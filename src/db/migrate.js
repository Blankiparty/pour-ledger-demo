'use strict';

const path = require('node:path');
const { migrate } = require('drizzle-orm/node-postgres/migrator');

const MIGRATIONS_FOLDER = path.join(__dirname, '..', '..', 'drizzle');

/** Apply Drizzle migrations. `schema` controls where the journal table lives. */
async function runMigrations(db, { schema = 'drizzle' } = {}) {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: schema });
}

module.exports = { runMigrations, MIGRATIONS_FOLDER };
