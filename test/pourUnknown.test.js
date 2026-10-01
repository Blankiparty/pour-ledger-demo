'use strict';

// "Payment approved, but pour result unknown."
// Record it, link it to the PaymentIntent, flag it, and wait for evidence.
// Never refund on our own, never dispense again, never call it poured.

const request = require('supertest');
const { createApp } = require('../src/app');
const { createTestDb } = require('./helpers/testDb');
const { WEBHOOK_SECRET, createFakeStripe, piEvent, sign } = require('./helpers/fakeStripe');

let tdb;
let stripe;
let app;
let keySeq = 0;

beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb.close();
});
beforeEach(async () => {
  await tdb.reset();
  stripe = createFakeStripe();
  app = createApp({ db: tdb.db, stripe, webhookSecret: WEBHOOK_SECRET });
});

const device = (body, deviceId = 'st-007') =>
  request(app)
    .post(`/devices/${deviceId}/events`)
    .set('Idempotency-Key', `unk-${String(++keySeq).padStart(6, '0')}`)
    .send(body);

const resolve = (attemptId, decision, operator = 'dana') =>
  request(app).post(`/reconciliation/${attemptId}/resolve`).send({ decision, operator, note: 'checked camera' });

async function webhook(event) {
  const { payload, header } = sign(stripe, event);
  return request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', header)
    .send(payload);
}

async function attempt(id) {
  const { rows } = await tdb.pool.query('select * from pour_attempts where id = $1', [id]);
  return rows[0];
}

async function paymentStatus(pi) {
  const { rows } = await tdb.pool.query('select status from payments where id = $1', [pi]);
  return rows[0] && rows[0].status;
}

/** Paid at Stripe, pour started, then the device lost track of the result. */
async function approvedThenUnknown(pi = 'pi_unk1') {
  stripe.setIntent(pi, 'succeeded');
  await webhook(piEvent('payment_intent.succeeded', pi, 'succeeded'));
  const s = await device({ type: 'pour.started', paymentIntentId: pi });
  const u = await device({ type: 'pour.unknown', attemptId: s.body.attemptId, detail: { reason: 'flow sensor timeout' } });
  return { pi, attemptId: s.body.attemptId, res: u };
}

describe('recording the unknown pour', () => {
  test('it is stored as UNKNOWN, linked to the PaymentIntent, and flagged', async () => {
    const { pi, attemptId, res } = await approvedThenUnknown();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ attemptId, paymentIntentId: pi, state: 'UNKNOWN', needsReconciliation: true });

    const row = await attempt(attemptId);
    expect(row.payment_intent_id).toBe(pi);
    expect(row.resolution).toBeNull();
  });

  test('it appears in the reconciliation queue next to the payment status', async () => {
    const { pi, attemptId } = await approvedThenUnknown();
    const queue = await request(app).get('/reconciliation');
    expect(queue.body.items).toEqual([
      expect.objectContaining({ attemptId, paymentIntentId: pi, state: 'UNKNOWN', paymentStatus: 'succeeded' }),
    ]);
  });

  test('a device that rebooted and lost the attempt id still lands on the same attempt', async () => {
    stripe.setIntent('pi_reboot', 'succeeded');
    const s = await device({ type: 'pour.started', paymentIntentId: 'pi_reboot' });
    const u = await device({ type: 'pour.unknown', paymentIntentId: 'pi_reboot' });
    expect(u.body.attemptId).toBe(s.body.attemptId);
    expect(u.body.state).toBe('UNKNOWN');
  });

  test('a report that arrives before Stripe\'s webhook is still recorded', async () => {
    const u = await device({ type: 'pour.unknown', paymentIntentId: 'pi_early' });
    expect(u.status).toBe(201);
    expect(u.body.state).toBe('UNKNOWN');
    const queue = await request(app).get('/reconciliation');
    expect(queue.body.items[0]).toMatchObject({ paymentIntentId: 'pi_early', paymentStatus: null });
  });

  test('every state change is in the audit log with its source', async () => {
    const { attemptId } = await approvedThenUnknown();
    const { rows } = await tdb.pool.query(
      'select from_state, to_state, source from pour_attempt_log where attempt_id = $1 order by at, to_state',
      [attemptId],
    );
    expect(rows).toEqual([
      { from_state: null, to_state: 'DISPENSING', source: 'device:st-007' },
      { from_state: 'DISPENSING', to_state: 'UNKNOWN', source: 'device:st-007' },
    ]);
  });
});

describe('never auto-refund', () => {
  test('no refund is requested and the payment stays succeeded', async () => {
    const { pi } = await approvedThenUnknown();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(await paymentStatus(pi)).toBe('succeeded');
  });

  test('later payment webhooks for the same intent do not trigger a refund either', async () => {
    const { pi } = await approvedThenUnknown();
    await webhook(piEvent('payment_intent.succeeded', pi, 'succeeded'));
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  test('a device-confirmed failure is flagged for an operator, still not refunded', async () => {
    const { attemptId } = await approvedThenUnknown();
    const f = await device({ type: 'pour.failed', attemptId, reason: 'cup sensor empty' });
    expect(f.body).toMatchObject({ state: 'FAILED', needsReconciliation: true });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
});

describe('never re-dispense', () => {
  test('a new pour for the same payment is refused while the result is unknown', async () => {
    const { pi } = await approvedThenUnknown();
    const again = await device({ type: 'pour.started', paymentIntentId: pi });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('payment_already_has_live_pour');
  });

  test('the refusal holds at the database level, not just in app code', async () => {
    const { pi } = await approvedThenUnknown();
    await expect(
      tdb.pool.query("insert into pour_attempts (device_id, payment_intent_id, state) values ('st-008', $1, 'DISPENSING')", [pi]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'pour_attempts_one_live_per_payment_uq' });
  });

  test('another station cannot dispense on the same payment either', async () => {
    const { pi } = await approvedThenUnknown();
    const other = await device({ type: 'pour.started', paymentIntentId: pi }, 'st-099');
    expect(other.status).toBe(409);
  });
});

describe('never mark it poured without evidence', () => {
  test('payment webhooks, replays and time passing leave it UNKNOWN', async () => {
    const { pi, attemptId } = await approvedThenUnknown();
    await webhook(piEvent('payment_intent.succeeded', pi, 'succeeded'));
    await device({ type: 'pour.unknown', attemptId }); // device repeats itself
    await tdb.pool.query("update pour_attempts set created_at = now() - interval '7 days' where id = $1", [attemptId]);
    expect((await attempt(attemptId)).state).toBe('UNKNOWN');
  });

  test('an operator refund resolves it as FAILED, never POURED', async () => {
    const { attemptId } = await approvedThenUnknown();
    const r = await resolve(attemptId, 'refund');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'FAILED', resolution: 'operator_refunded', needsReconciliation: false });
  });
});

describe('waiting for evidence', () => {
  test('the device\'s later report resolves it and clears the flag', async () => {
    const { attemptId } = await approvedThenUnknown();
    const done = await device({ type: 'pour.completed', attemptId, volumeMl: 210 });
    expect(done.body).toMatchObject({ state: 'POURED', needsReconciliation: false, resolution: 'device_confirmed_poured' });
    expect((await request(app).get('/reconciliation')).body.items).toHaveLength(0);
  });

  test('an operator can confirm the pour', async () => {
    const { attemptId } = await approvedThenUnknown();
    const r = await resolve(attemptId, 'confirm_poured');
    expect(r.body).toMatchObject({ state: 'POURED', resolution: 'operator_confirmed_poured' });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect((await attempt(attemptId)).resolved_by).toBe('operator:dana');
  });

  test('an operator refund is requested once, with an idempotency key tied to the attempt', async () => {
    const { pi, attemptId } = await approvedThenUnknown();
    await resolve(attemptId, 'refund');
    const second = await resolve(attemptId, 'refund');

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('not_awaiting_reconciliation');
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: pi }),
      { idempotencyKey: `pour-attempt-refund:${attemptId}` },
    );
    // The payment row moves only when Stripe confirms via charge.refunded.
    expect(await paymentStatus(pi)).toBe('succeeded');
  });

  test('a late "completed" after an operator refund is refused, not silently applied', async () => {
    const { attemptId } = await approvedThenUnknown();
    await resolve(attemptId, 'refund');
    const late = await device({ type: 'pour.completed', attemptId });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('invalid_pour_transition');
    expect((await attempt(attemptId)).state).toBe('FAILED');
  });
});
