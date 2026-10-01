'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const { createTestDb } = require('./helpers/testDb');
const { WEBHOOK_SECRET, createFakeStripe } = require('./helpers/fakeStripe');

let tdb;
let app;

beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb.close();
});
beforeEach(async () => {
  await tdb.reset();
  app = createApp({ db: tdb.db, stripe: createFakeStripe(), webhookSecret: WEBHOOK_SECRET });
});

const send = (deviceId, key, body) => {
  const req = request(app).post(`/devices/${deviceId}/events`);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};

const started = (pi) => ({ type: 'pour.started', paymentIntentId: pi, detail: { product: 'flat_white' } });

async function count(table) {
  const { rows } = await tdb.pool.query(`select count(*)::int as n from ${table}`);
  return rows[0].n;
}

describe('POST /devices/:id/events', () => {
  test('requires a device-generated Idempotency-Key', async () => {
    const res = await send('st-001', null, started('pi_a'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_idempotency_key');
    expect(await count('device_events')).toBe(0);
  });

  test('rejects malformed events before touching the ledger', async () => {
    const res = await send('st-001', 'key-0000-bad', { type: 'pour.completed', attemptId: 'nope' });
    expect(res.status).toBe(422);
    expect(await count('device_events')).toBe(0);
  });

  test('first delivery is applied and its response stored', async () => {
    const res = await send('st-001', 'key-0000-0001', started('pi_a'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ paymentIntentId: 'pi_a', state: 'DISPENSING' });
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  test('a replay with the same payload returns the original response, byte for byte', async () => {
    const first = await send('st-001', 'key-0000-0002', started('pi_b'));
    const replay = await send('st-001', 'key-0000-0002', started('pi_b'));

    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual(first.body); // same attemptId: the device can carry on
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await count('pour_attempts')).toBe(1);
  });

  test('key order in the JSON does not matter for "same payload"', async () => {
    await send('st-001', 'key-0000-0003', { type: 'pour.started', paymentIntentId: 'pi_c' });
    const replay = await send('st-001', 'key-0000-0003', { paymentIntentId: 'pi_c', type: 'pour.started' });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  test('the same key with a different payload is a 409 and changes nothing', async () => {
    await send('st-001', 'key-0000-0004', started('pi_d'));
    const reused = await send('st-001', 'key-0000-0004', started('pi_other'));

    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe('idempotency_key_reused');
    expect(await count('pour_attempts')).toBe(1);
  });

  test('keys are scoped per device', async () => {
    const a = await send('st-001', 'key-0000-0005', started('pi_e1'));
    const b = await send('st-002', 'key-0000-0005', started('pi_e2'));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.attemptId).not.toBe(a.body.attemptId);
  });

  test('ten concurrent retries of one request create exactly one attempt and agree on the answer', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => send('st-001', 'key-0000-0006', started('pi_f'))),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.attemptId)).size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(9);
    expect(await count('pour_attempts')).toBe(1);
    expect(await count('device_events')).toBe(1);
  });

  test('a refused event is stored too, so its replay gets the same refusal', async () => {
    await send('st-001', 'key-0000-0007', started('pi_g'));
    const refused = await send('st-001', 'key-0000-0008', started('pi_g'));
    const replay = await send('st-001', 'key-0000-0008', started('pi_g'));

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('payment_already_has_live_pour');
    expect(replay.status).toBe(409);
    expect(replay.body).toEqual(refused.body);
  });

  test('a normal pour: started then completed', async () => {
    const s = await send('st-001', 'key-0000-0009', started('pi_h'));
    const done = await send('st-001', 'key-0000-0010', {
      type: 'pour.completed',
      attemptId: s.body.attemptId,
      volumeMl: 220,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: 'POURED', needsReconciliation: false });
  });

  test('a device cannot report on another device\'s attempt', async () => {
    const s = await send('st-001', 'key-0000-0011', started('pi_i'));
    const res = await send('st-999', 'key-0000-0012', { type: 'pour.completed', attemptId: s.body.attemptId });
    expect(res.status).toBe(404);
  });
});
