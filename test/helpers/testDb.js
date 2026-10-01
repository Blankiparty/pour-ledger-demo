'use strict';

const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { createDb } = require('../../src/db/client');
const { runMigrations } = require('../../src/db/migrate');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Run `npm run test:local` (starts a throwaway Postgres 16 on 127.0.0.1) ' +
        'or point DATABASE_URL at a disposable local database.',
    );
  }
  // Tests drop schemas. Refuse anything that is not a local, throwaway server.
  const { hostname } = new URL(url);
  if (!LOCAL_HOSTS.has(hostname)) throw new Error(`Refusing to run tests against non-local host ${hostname}`);
  return url;
}

/**
 * Give one test file its own Postgres schema with all migrations applied.
 * Every connection in the file's pool has search_path pinned to that schema,
 * so parallel files and parallel CI shards never see each other's rows.
 */
async function createTestDb() {
  const url = databaseUrl();
  const schema = `t_${process.env.JEST_WORKER_ID || '0'}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema "${schema}"`);

  const { pool, db } = createDb({ connectionString: url, searchPath: schema, max: 8 });
  await runMigrations(db, { schema });

  return {
    db,
    pool,
    schema,
    /** Empty every table so each test starts from the same state. */
    async reset() {
      await pool.query(
        'truncate payments, processed_events, device_events, pour_attempts, pour_attempt_log restart identity',
      );
    },
    async close() {
      await pool.end();
      await admin.query(`drop schema "${schema}" cascade`);
      await admin.end();
    },
  };
}

module.exports = { createTestDb };
