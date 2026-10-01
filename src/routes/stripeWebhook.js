'use strict';

const express = require('express');
const { eq, sql } = require('drizzle-orm');
const { payments, processedEvents } = require('../db/schema');
const { canMovePayment, statusFromPaymentIntent } = require('../domain/paymentState');

const PAYMENT_EVENTS = new Set([
  'payment_intent.created',
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
]);

function paymentIntentIdOf(event) {
  const obj = event.data && event.data.object;
  if (!obj) return null;
  if (event.type.startsWith('payment_intent.')) return obj.id;
  if (event.type === 'charge.refunded') {
    return typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent && obj.payment_intent.id;
  }
  return null;
}

/**
 * POST /webhooks/stripe
 *
 * 1. Verify the signature against the raw bytes (no JSON parser runs first).
 * 2. Skip event ids we already handled: duplicates return 200 and change nothing.
 * 3. Never trust delivery order or the payload's status. Re-fetch the
 *    PaymentIntent from Stripe and only move our row along the allowed
 *    transitions, so a late or stale event can never undo a newer state.
 * 4. Record the event id and the state change in one transaction. If anything
 *    fails we return 500, nothing is recorded, and Stripe's retry gets a clean run.
 */
function stripeWebhookRouter({ db, stripe, webhookSecret }) {
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is required');
  const router = express.Router();

  router.post('/', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    const signature = req.get('stripe-signature');
    if (!signature || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'missing_signature' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch {
      return res.status(400).json({ error: 'invalid_signature' });
    }

    // Cheap early exit for redeliveries. The insert further down is the real guard.
    const seen = await db
      .select({ eventId: processedEvents.eventId })
      .from(processedEvents)
      .where(eq(processedEvents.eventId, event.id));
    if (seen.length > 0) return res.status(200).json({ received: true, duplicate: true });

    if (!PAYMENT_EVENTS.has(event.type)) {
      await db
        .insert(processedEvents)
        .values({ eventId: event.id, type: event.type, outcome: 'ignored_unhandled', eventCreated: event.created })
        .onConflictDoNothing();
      return res.status(200).json({ received: true, outcome: 'ignored_unhandled' });
    }

    const paymentIntentId = paymentIntentIdOf(event);
    if (!paymentIntentId) return res.status(400).json({ error: 'event_without_payment_intent' });

    // Source of truth is Stripe's current object, not the event snapshot.
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const target = statusFromPaymentIntent(intent);

    const result = await db.transaction(async (tx) => {
      const claimed = await tx
        .insert(processedEvents)
        .values({
          eventId: event.id,
          type: event.type,
          objectId: paymentIntentId,
          outcome: 'applied',
          eventCreated: event.created,
        })
        .onConflictDoNothing()
        .returning({ eventId: processedEvents.eventId });
      // A concurrent delivery of the same event committed first.
      if (claimed.length === 0) return { duplicate: true };

      const created = await tx
        .insert(payments)
        .values({
          id: paymentIntentId,
          status: target,
          amountCents: intent.amount,
          currency: intent.currency,
          lastEventCreated: event.created,
        })
        .onConflictDoNothing()
        .returning({ id: payments.id });

      let outcome = 'applied';
      let status = target;
      if (created.length === 0) {
        const [current] = await tx.select().from(payments).where(eq(payments.id, paymentIntentId)).for('update');
        if (current.status === target) {
          outcome = 'no_change';
        } else if (canMovePayment(current.status, target)) {
          await tx
            .update(payments)
            .set({
              status: target,
              lastEventCreated: sql`greatest(${payments.lastEventCreated}, ${event.created})`,
              updatedAt: sql`now()`,
            })
            .where(eq(payments.id, paymentIntentId));
        } else {
          outcome = 'ignored_stale';
          status = current.status;
        }
        if (outcome !== 'applied') {
          await tx.update(processedEvents).set({ outcome }).where(eq(processedEvents.eventId, event.id));
        }
      }
      return { outcome, status };
    });

    if (result.duplicate) return res.status(200).json({ received: true, duplicate: true });
    return res.status(200).json({ received: true, outcome: result.outcome, status: result.status });
  });

  return router;
}

module.exports = { stripeWebhookRouter, PAYMENT_EVENTS };
