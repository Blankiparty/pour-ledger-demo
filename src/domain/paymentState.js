'use strict';

// Our view of a Stripe PaymentIntent. Stripe's requires_* states collapse into
// `pending`; a fully refunded charge becomes `refunded`.
const PAYMENT_STATUSES = ['pending', 'processing', 'succeeded', 'canceled', 'refunded'];

// Allowed moves. Terminal states (canceled, refunded) have no way out, and a
// succeeded payment can only become refunded. Anything else is a stale read
// or a late delivery and is ignored.
const PAYMENT_TRANSITIONS = {
  pending: ['processing', 'succeeded', 'canceled'],
  processing: ['pending', 'succeeded', 'canceled'], // pending = attempt failed, customer may retry
  succeeded: ['refunded'],
  canceled: [],
  refunded: [],
};

function canMovePayment(from, to) {
  return (PAYMENT_TRANSITIONS[from] || []).includes(to);
}

/** Map a freshly retrieved Stripe PaymentIntent (latest_charge expanded) to our status. */
function statusFromPaymentIntent(pi) {
  switch (pi.status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      return 'pending';
    case 'processing':
    case 'requires_capture':
      return 'processing';
    case 'canceled':
      return 'canceled';
    case 'succeeded': {
      const charge = pi.latest_charge;
      if (charge && typeof charge === 'object' && charge.refunded === true) return 'refunded';
      return 'succeeded';
    }
    default:
      throw new Error(`Unknown PaymentIntent status: ${pi.status}`);
  }
}

module.exports = { PAYMENT_STATUSES, PAYMENT_TRANSITIONS, canMovePayment, statusFromPaymentIntent };
