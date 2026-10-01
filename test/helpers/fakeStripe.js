'use strict';

const Stripe = require('stripe');

// Fake values. Nothing here is a real key or secret.
const WEBHOOK_SECRET = 'whsec_test_pour_ledger_demo_only';

/**
 * A Stripe client for tests:
 * - `webhooks` is the real SDK implementation, so signatures are checked for real.
 * - `paymentIntents.retrieve` and `refunds.create` are jest fakes backed by a map.
 * The real client points at a closed local port, so an accidental network call fails fast.
 */
function createFakeStripe() {
  const real = new Stripe('sk_test_fake_never_sent', {
    host: '127.0.0.1',
    port: 9,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeout: 500,
  });
  const intents = new Map();
  let refundSeq = 0;

  const fake = {
    webhooks: real.webhooks,
    paymentIntents: {
      retrieve: jest.fn(async (id) => {
        const pi = intents.get(id);
        if (!pi) {
          const err = new Error(`No such payment_intent: '${id}'`);
          err.statusCode = 404;
          throw err;
        }
        return structuredClone(pi);
      }),
    },
    refunds: {
      create: jest.fn(async (params) => ({
        id: `re_test_${++refundSeq}`,
        object: 'refund',
        payment_intent: params.payment_intent,
        status: 'succeeded',
      })),
    },
    /** Set what Stripe "currently" says about a PaymentIntent. */
    setIntent(id, status, { refunded = false, amount = 450, currency = 'eur' } = {}) {
      intents.set(id, {
        id,
        object: 'payment_intent',
        status,
        amount,
        currency,
        latest_charge: { id: `ch_${id.slice(3)}`, object: 'charge', refunded },
      });
    },
  };
  return fake;
}

let eventSeq = 0;

/** Build a Stripe-shaped event. `created` defaults to a fixed, increasing clock. */
function makeEvent(type, object, { id, created } = {}) {
  eventSeq += 1;
  return {
    id: id || `evt_test_${eventSeq}`,
    object: 'event',
    api_version: '2025-01-27',
    created: created || 1790000000 + eventSeq,
    livemode: false,
    type,
    data: { object },
  };
}

function piEvent(type, piId, status, opts) {
  return makeEvent(type, { id: piId, object: 'payment_intent', status, amount: 450, currency: 'eur' }, opts);
}

/** Serialise and sign exactly like Stripe does. */
function sign(stripe, event, { secret = WEBHOOK_SECRET, timestamp } = {}) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
  return { payload, header };
}

module.exports = { WEBHOOK_SECRET, createFakeStripe, makeEvent, piEvent, sign };
