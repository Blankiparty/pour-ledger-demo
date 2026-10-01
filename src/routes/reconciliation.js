'use strict';

const express = require('express');
const { asc, eq, sql } = require('drizzle-orm');
const { payments, pourAttempts } = require('../db/schema');
const { lockAttempt, transition, view } = require('../domain/pours');
const { HttpError } = require('../httpError');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS = ['confirm_poured', 'refund'];

/**
 * Operator side of "payment approved, pour result unknown".
 *
 * GET  /reconciliation                    flagged attempts with their payment status
 * POST /reconciliation/:attemptId/resolve { decision, operator, note }
 *
 * This is the only code path in the service that can issue a refund, and it
 * only runs on an explicit operator decision. The refund uses a Stripe
 * idempotency key tied to the attempt, so a double click cannot refund twice.
 * The payment row itself moves to `refunded` when Stripe's charge.refunded
 * webhook arrives, never here.
 */
function reconciliationRouter({ db, stripe }) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const rows = await db
      .select({
        attemptId: pourAttempts.id,
        deviceId: pourAttempts.deviceId,
        paymentIntentId: pourAttempts.paymentIntentId,
        state: pourAttempts.state,
        createdAt: pourAttempts.createdAt,
        paymentStatus: payments.status,
        amountCents: payments.amountCents,
      })
      .from(pourAttempts)
      .leftJoin(payments, eq(payments.id, pourAttempts.paymentIntentId))
      .where(eq(pourAttempts.needsReconciliation, true))
      .orderBy(asc(pourAttempts.createdAt));
    res.json({ items: rows });
  });

  router.post('/:attemptId/resolve', express.json({ limit: '16kb' }), async (req, res) => {
    const { attemptId } = req.params;
    const { decision, operator, note } = req.body || {};
    if (!UUID.test(attemptId)) throw new HttpError(404, 'attempt_not_found');
    if (!DECISIONS.includes(decision)) throw new HttpError(422, 'invalid_decision', `decision must be one of ${DECISIONS.join(', ')}`);
    if (!operator || typeof operator !== 'string') throw new HttpError(422, 'operator_required');

    const source = `operator:${operator}`;
    const result = await db.transaction(async (tx) => {
      const row = await lockAttempt(tx, attemptId);
      if (!row) throw new HttpError(404, 'attempt_not_found');
      if (!row.needsReconciliation) {
        throw new HttpError(409, 'not_awaiting_reconciliation', 'This attempt was already resolved.', view(row));
      }

      if (decision === 'confirm_poured') {
        return transition(
          tx,
          row,
          'POURED',
          source,
          { needsReconciliation: false, resolution: 'operator_confirmed_poured', resolvedBy: source, resolvedAt: sql`now()` },
          note,
        );
      }

      // decision === 'refund'
      if (row.state !== 'UNKNOWN' && row.state !== 'FAILED') {
        throw new HttpError(409, 'invalid_pour_transition', `A pour in ${row.state} cannot be refunded here.`);
      }
      const refund = await stripe.refunds.create(
        { payment_intent: row.paymentIntentId, metadata: { pour_attempt_id: row.id, operator } },
        { idempotencyKey: `pour-attempt-refund:${row.id}` },
      );
      const patch = {
        needsReconciliation: false,
        resolution: 'operator_refunded',
        resolvedBy: source,
        resolvedAt: sql`now()`,
        refundId: refund.id,
      };
      if (row.state === 'FAILED') {
        const [updated] = await tx.update(pourAttempts).set(patch).where(eq(pourAttempts.id, row.id)).returning();
        return { status: 200, body: view(updated) };
      }
      return transition(tx, row, 'FAILED', source, patch, note);
    });

    res.status(result.status).json({ ...result.body, ...(decision === 'refund' && { refundRequested: true }) });
  });

  return router;
}

module.exports = { reconciliationRouter };
