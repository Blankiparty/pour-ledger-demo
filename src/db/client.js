'use strict';

const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const schema = require('./schema');

/**
 * Create a pg pool + Drizzle instance.
 * `searchPath` pins every connection to one schema. Tests use it to give
 * each test file its own schema inside the same Postgres database.
 */
function createDb({ connectionString, searchPath, max = 5 } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString,
    max,
    options: searchPath ? `-c search_path=${searchPath}` : undefined,
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

module.exports = { createDb };
