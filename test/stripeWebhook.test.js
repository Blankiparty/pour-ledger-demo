'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const { createTestDb } = require('./helpers/testDb');
const { WEBHOOK_SECRET, createFakeStripe, makeEvent, piEvent, sign } = require('./helpers/fakeStripe');

let tdb;
let stripe;
let app;

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

function deliver(event, signOpts) {
  const { payload, header } = sign(stripe, event, signOpts);
  return request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', header)
    .send(payload);
}

async function paymentRow(id) {
  const { rows } = await tdb.pool.query('select status, last_event_created from payments where id = $1', [id]);
  return rows[0];
}

async function processedCount() {
  const { rows } = await tdb.pool.query('select count(*)::int as n from processed_events');
  return rows[0].n;
}

describe('signature check (raw body + constructEvent)', () => {
  test('accepts a correctly signed event', async () => {
    stripe.setIntent('pi_sig1', 'succeeded');
    const res = await deliver(piEvent('payment_intent.succeeded', 'pi_sig1', 'succeeded'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, outcome: 'applied', status: 'succeeded' });
  });

  test('rejects a missing signature header', async () => {
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(piEvent('payment_intent.succeeded', 'pi_x', 'succeeded')));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_signature');
    expect(await processedCount()).toBe(0);
  });

  test('rejects a body signed with another secret', async () => {
    const res = await deliver(piEvent('payment_intent.succeeded', 'pi_x', 'succeeded'), {
      secret: 'whsec_someone_else',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_signature');
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  test('rejects a body changed after signing, even by one byte of whitespace', async () => {
    const event = piEvent('payment_intent.succeeded', 'pi_x', 'succeeded');
    const { payload, header } = sign(stripe, event);
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(`${payload} `);
    expect(res.status).toBe(400);
    expect(await processedCount()).toBe(0);
  });

  test('rejects a replayed signature older than the 5 minute tolerance', async () => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const res = await deliver(piEvent('payment_intent.succeeded', 'pi_x', 'succeeded'), { timestamp: tenMinutesAgo });
    expect(res.status).toBe(400);
  });
});

describe('duplicates', () => {
  test('the same event delivered twice returns 200 and has no second effect', async () => {
    stripe.setIntent('pi_dup', 'succeeded');
    const event = piEvent('payment_intent.succeeded', 'pi_dup', 'succeeded');

    const first = await deliver(event);
    const second = await deliver(event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledTimes(1);
    expect(await processedCount()).toBe(1);
  });

  test('five concurrent deliveries of one event are applied exactly once', async () => {
    stripe.setIntent('pi_race', 'succeeded');
    const event = piEvent('payment_intent.succeeded', 'pi_race', 'succeeded');

    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(event)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.outcome === 'applied')).toHaveLength(1);
    expect(await processedCount()).toBe(1);
    expect((await paymentRow('pi_race')).status).toBe('succeeded');
  });

  test('unhandled event types are acknowledged and recorded once', async () => {
    const event = makeEvent('customer.created', { id: 'cus_1', object: 'customer' });
    expect((await deliver(event)).body.outcome).toBe('ignored_unhandled');
    expect((await deliver(event)).body.duplicate).toBe(true);
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });
});

describe('out-of-order delivery', () => {
  test('a late "processing" event cannot move a succeeded payment backwards', async () => {
    stripe.setIntent('pi_ooo', 'succeeded');
    await deliver(piEvent('payment_intent.succeeded', 'pi_ooo', 'succeeded', { created: 1790000200 }));

    // Delivered later, created earlier. Stripe still reports succeeded.
    const late = await deliver(piEvent('payment_intent.processing', 'pi_ooo', 'processing', { created: 1790000100 }));

    expect(late.status).toBe(200);
    expect(late.body.status).toBe('succeeded');
    expect((await paymentRow('pi_ooo')).status).toBe('succeeded');
  });

  test('a stale read during a race is refused by the transition table', async () => {
    stripe.setIntent('pi_stale', 'succeeded');
    await deliver(piEvent('payment_intent.succeeded', 'pi_stale', 'succeeded'));

    // Simulate a handler that fetched the intent just before it succeeded.
    stripe.setIntent('pi_stale', 'processing');
    const res = await deliver(piEvent('payment_intent.processing', 'pi_stale', 'processing'));

    expect(res.body).toMatchObject({ outcome: 'ignored_stale', status: 'succeeded' });
    expect((await paymentRow('pi_stale')).status).toBe('succeeded');
    const { rows } = await tdb.pool.query("select outcome from processed_events where type = 'payment_intent.processing'");
    expect(rows[0].outcome).toBe('ignored_stale');
  });

  test('the payload is not trusted: status comes from the re-fetched PaymentIntent', async () => {
    stripe.setIntent('pi_truth', 'succeeded');
    const res = await deliver(piEvent('payment_intent.processing', 'pi_truth', 'processing'));
    expect(res.body.status).toBe('succeeded');
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_truth', { expand: ['latest_charge'] });
  });

  test('refunded is terminal: a late "succeeded" event does not undo it', async () => {
    stripe.setIntent('pi_ref', 'succeeded');
    await deliver(piEvent('payment_intent.succeeded', 'pi_ref', 'succeeded'));

    stripe.setIntent('pi_ref', 'succeeded', { refunded: true });
    const refunded = await deliver(
      makeEvent('charge.refunded', { id: 'ch_ref', object: 'charge', payment_intent: 'pi_ref', refunded: true }),
    );
    expect(refunded.body.status).toBe('refunded');

    stripe.setIntent('pi_ref', 'succeeded'); // stale read
    await deliver(piEvent('payment_intent.succeeded', 'pi_ref', 'succeeded'));
    expect((await paymentRow('pi_ref')).status).toBe('refunded');
  });

  test('a failed attempt after processing returns to pending; canceled is terminal', async () => {
    stripe.setIntent('pi_fail', 'processing');
    await deliver(piEvent('payment_intent.processing', 'pi_fail', 'processing'));
    stripe.setIntent('pi_fail', 'requires_payment_method');
    await deliver(piEvent('payment_intent.payment_failed', 'pi_fail', 'requires_payment_method'));
    expect((await paymentRow('pi_fail')).status).toBe('pending');

    stripe.setIntent('pi_fail', 'canceled');
    await deliver(piEvent('payment_intent.canceled', 'pi_fail', 'canceled'));
    stripe.setIntent('pi_fail', 'processing');
    await deliver(piEvent('payment_intent.processing', 'pi_fail', 'processing'));
    expect((await paymentRow('pi_fail')).status).toBe('canceled');
  });
});

describe('failure handling', () => {
  test('if Stripe cannot be reached we return 500, record nothing, and the retry succeeds', async () => {
    const event = piEvent('payment_intent.succeeded', 'pi_flaky', 'succeeded');
    stripe.paymentIntents.retrieve.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

    const first = await deliver(event);
    expect(first.status).toBe(500);
    expect(await processedCount()).toBe(0);

    stripe.setIntent('pi_flaky', 'succeeded');
    const retry = await deliver(event);
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('applied');
    expect((await paymentRow('pi_flaky')).status).toBe('succeeded');
  });
});
