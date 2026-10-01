'use strict';

const { PAYMENT_STATUSES, canMovePayment, statusFromPaymentIntent } = require('../src/domain/paymentState');
const { POUR_STATES, canMovePour } = require('../src/domain/pourState');
const { canonicalJson, requestHash } = require('../src/canonicalJson');

describe('payment transitions', () => {
  test.each([
    ['pending', 'processing', true],
    ['pending', 'succeeded', true],
    ['processing', 'succeeded', true],
    ['processing', 'pending', true],
    ['succeeded', 'refunded', true],
    ['succeeded', 'processing', false],
    ['succeeded', 'pending', false],
    ['succeeded', 'canceled', false],
    ['refunded', 'succeeded', false],
    ['canceled', 'processing', false],
  ])('%s -> %s allowed: %s', (from, to, allowed) => {
    expect(canMovePayment(from, to)).toBe(allowed);
  });

  test('terminal states have no way out', () => {
    for (const to of PAYMENT_STATUSES) {
      expect(canMovePayment('canceled', to)).toBe(false);
      expect(canMovePayment('refunded', to)).toBe(false);
    }
  });

  test('Stripe statuses map onto ours', () => {
    expect(statusFromPaymentIntent({ status: 'requires_action' })).toBe('pending');
    expect(statusFromPaymentIntent({ status: 'requires_capture' })).toBe('processing');
    expect(statusFromPaymentIntent({ status: 'succeeded', latest_charge: { refunded: false } })).toBe('succeeded');
    expect(statusFromPaymentIntent({ status: 'succeeded', latest_charge: { refunded: true } })).toBe('refunded');
    expect(statusFromPaymentIntent({ status: 'succeeded', latest_charge: 'ch_123' })).toBe('succeeded');
    expect(() => statusFromPaymentIntent({ status: 'something_new' })).toThrow();
  });
});

describe('pour transitions', () => {
  test('UNKNOWN can only become POURED or FAILED', () => {
    expect(POUR_STATES.filter((to) => canMovePour('UNKNOWN', to))).toEqual(['POURED', 'FAILED']);
  });

  test('nothing goes back to DISPENSING, and final states are final', () => {
    for (const from of POUR_STATES) expect(canMovePour(from, 'DISPENSING')).toBe(false);
    for (const to of POUR_STATES) {
      expect(canMovePour('POURED', to)).toBe(false);
      expect(canMovePour('FAILED', to)).toBe(false);
    }
  });
});

describe('request hashing for idempotency', () => {
  test('key order does not change the hash; values do', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"b":1}');
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});
