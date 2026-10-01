'use strict';

// Proves the test harness itself: each test file gets its own migrated schema,
// so files can run in parallel (and across CI shards) without sharing rows.

const { createTestDb } = require('./helpers/testDb');

let a;
let b;

beforeAll(async () => {
  [a, b] = await Promise.all([createTestDb(), createTestDb()]);
});
afterAll(async () => {
  await Promise.all([a.close(), b.close()]);
});

test('every connection is pinned to the file\'s own schema', async () => {
  const { rows } = await a.pool.query('select current_schema() as s');
  expect(rows[0].s).toBe(a.schema);
  expect(a.schema).not.toBe(b.schema);
});

test('migrations ran inside that schema', async () => {
  const { rows } = await a.pool.query(
    'select table_name from information_schema.tables where table_schema = $1 order by table_name',
    [a.schema],
  );
  expect(rows.map((r) => r.table_name)).toEqual([
    '__drizzle_migrations',
    'device_events',
    'payments',
    'pour_attempt_log',
    'pour_attempts',
    'processed_events',
  ]);
});

test('rows written in one schema are invisible in another', async () => {
  await a.pool.query(
    "insert into payments (id, status, amount_cents, currency, last_event_created) values ('pi_iso', 'succeeded', 450, 'eur', 1)",
  );
  const inA = await a.pool.query('select count(*)::int as n from payments');
  const inB = await b.pool.query('select count(*)::int as n from payments');
  expect(inA.rows[0].n).toBe(1);
  expect(inB.rows[0].n).toBe(0);
});

test('reset() returns a file to empty tables between tests', async () => {
  await a.reset();
  const { rows } = await a.pool.query('select count(*)::int as n from payments');
  expect(rows[0].n).toBe(0);
});
