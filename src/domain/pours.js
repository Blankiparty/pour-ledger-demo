'use strict';

const { and, eq, inArray, sql } = require('drizzle-orm');
const { pourAttempts, pourAttemptLog } = require('../db/schema');
const { canMovePour } = require('./pourState');
const { HttpError } = require('../httpError');

const ONE_LIVE_POUR = 'pour_attempts_one_live_per_payment_uq';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PI_ID = /^pi_[A-Za-z0-9]+$/;

const DEVICE_EVENT_TYPES = ['pour.started', 'pour.completed', 'pour.failed', 'pour.unknown'];

/** Returns a list of problems; empty means the body is usable. */
function validateDeviceEvent(body) {
  const problems = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['body must be a JSON object'];
  if (!DEVICE_EVENT_TYPES.includes(body.type)) problems.push(`type must be one of ${DEVICE_EVENT_TYPES.join(', ')}`);
  const needsPi = body.type === 'pour.started' || (body.type === 'pour.unknown' && !body.attemptId);
  if (needsPi && !PI_ID.test(String(body.paymentIntentId || ''))) problems.push('paymentIntentId (pi_...) is required');
  const needsAttempt = body.type === 'pour.completed' || body.type === 'pour.failed';
  if ((needsAttempt || body.attemptId !== undefined) && !UUID.test(String(body.attemptId || ''))) {
    problems.push('attemptId must be a UUID');
  }
  return problems;
}

function pgError(err) {
  // Drizzle wraps driver errors; the pg error sits on `cause`.
  return err && err.code ? err : err && err.cause;
}

function isLivePourConflict(err) {
  const e = pgError(err);
  return Boolean(e && e.code === '23505' && e.constraint === ONE_LIVE_POUR);
}

const livePourRefused = () =>
  new HttpError(
    409,
    'payment_already_has_live_pour',
    'This payment already has a pour that is dispensing, poured or unresolved. A second dispense is refused.',
  );

async function log(tx, attemptId, fromState, toState, source, note) {
  await tx.insert(pourAttemptLog).values({ attemptId, fromState, toState, source, note: note || null });
}

function view(row) {
  return {
    attemptId: row.id,
    paymentIntentId: row.paymentIntentId,
    state: row.state,
    needsReconciliation: row.needsReconciliation,
    resolution: row.resolution,
  };
}

async function lockAttempt(tx, attemptId) {
  const [row] = await tx.select().from(pourAttempts).where(eq(pourAttempts.id, attemptId)).for('update');
  return row;
}

async function insertAttempt(tx, deviceId, evt, state) {
  try {
    const [row] = await tx
      .insert(pourAttempts)
      .values({
        deviceId,
        paymentIntentId: evt.paymentIntentId,
        state,
        needsReconciliation: state === 'UNKNOWN',
        detail: evt.detail || null,
      })
      .returning();
    return row;
  } catch (err) {
    if (isLivePourConflict(err)) throw livePourRefused();
    throw err;
  }
}

/** Move an attempt along the allowed transitions; the check is never skipped. */
async function transition(tx, row, to, source, patch = {}, note) {
  if (row.state === to) return { status: 200, body: { ...view(row), unchanged: true } };
  if (!canMovePour(row.state, to)) {
    throw new HttpError(409, 'invalid_pour_transition', `A pour in ${row.state} cannot become ${to}.`, {
      state: row.state,
    });
  }
  const [updated] = await tx
    .update(pourAttempts)
    .set({ state: to, updatedAt: sql`now()`, ...patch })
    .where(and(eq(pourAttempts.id, row.id), eq(pourAttempts.state, row.state)))
    .returning();
  await log(tx, row.id, row.state, to, source, note);
  return { status: 200, body: view(updated) };
}

async function deviceOwnedAttempt(tx, deviceId, attemptId) {
  const row = await lockAttempt(tx, attemptId);
  if (!row || row.deviceId !== deviceId) {
    throw new HttpError(404, 'attempt_not_found', 'No such pour attempt on this device.');
  }
  return row;
}

/**
 * Apply one device event inside the caller's transaction.
 * Returns { status, body }; business refusals are thrown as HttpError (4xx).
 */
async function applyDeviceEvent(tx, deviceId, evt) {
  const source = `device:${deviceId}`;
  switch (evt.type) {
    case 'pour.started': {
      const row = await insertAttempt(tx, deviceId, evt, 'DISPENSING');
      await log(tx, row.id, null, 'DISPENSING', source);
      return { status: 201, body: view(row) };
    }

    case 'pour.completed': {
      const row = await deviceOwnedAttempt(tx, deviceId, evt.attemptId);
      const fromUnknown = row.state === 'UNKNOWN';
      return transition(tx, row, 'POURED', source, {
        needsReconciliation: false,
        ...(fromUnknown && { resolution: 'device_confirmed_poured', resolvedBy: source, resolvedAt: sql`now()` }),
      });
    }

    case 'pour.failed': {
      // Paid, nothing poured. The money question stays open for an operator:
      // the backend never refunds on its own.
      const row = await deviceOwnedAttempt(tx, deviceId, evt.attemptId);
      return transition(tx, row, 'FAILED', source, { needsReconciliation: true }, evt.reason);
    }

    case 'pour.unknown': {
      // "Payment approved, pour result unknown": record it, flag it, wait.
      let row;
      if (evt.attemptId) {
        row = await deviceOwnedAttempt(tx, deviceId, evt.attemptId);
      } else {
        // The device may have lost the attempt id in a reboot; find the live one.
        [row] = await tx
          .select()
          .from(pourAttempts)
          .where(
            and(
              eq(pourAttempts.paymentIntentId, evt.paymentIntentId),
              inArray(pourAttempts.state, ['DISPENSING', 'POURED', 'UNKNOWN']),
            ),
          )
          .for('update');
        if (row && row.deviceId !== deviceId) throw livePourRefused();
      }
      if (!row) {
        const created = await insertAttempt(tx, deviceId, evt, 'UNKNOWN');
        await log(tx, created.id, null, 'UNKNOWN', source, evt.detail && evt.detail.reason);
        return { status: 201, body: view(created) };
      }
      return transition(tx, row, 'UNKNOWN', source, { needsReconciliation: true });
    }

    default:
      throw new HttpError(422, 'unknown_event_type');
  }
}

module.exports = {
  DEVICE_EVENT_TYPES,
  validateDeviceEvent,
  applyDeviceEvent,
  lockAttempt,
  transition,
  view,
};
