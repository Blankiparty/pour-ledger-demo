'use strict';

const express = require('express');
const { and, eq } = require('drizzle-orm');
const { deviceEvents } = require('../db/schema');
const { requestHash } = require('../canonicalJson');
const { validateDeviceEvent, applyDeviceEvent } = require('../domain/pours');
const { HttpError } = require('../httpError');

const KEY_FORMAT = /^[A-Za-z0-9._:-]{8,128}$/;
const DEVICE_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * POST /devices/:deviceId/events   (header: Idempotency-Key)
 *
 * Devices retry over flaky networks, so every request carries a key the
 * device generated once for that event. In one transaction we:
 *   - claim (device_id, key) with INSERT ... ON CONFLICT DO NOTHING
 *   - if it was already claimed: same payload -> replay the stored response,
 *     different payload -> 409
 *   - otherwise apply the event and store the response next to the key
 * A concurrent retry blocks on the unique index until the first one commits,
 * then replays its answer. 5xx errors roll everything back so a retry starts clean.
 */
function deviceEventsRouter({ db }) {
  const router = express.Router();

  router.post('/:deviceId/events', express.json({ limit: '64kb' }), async (req, res) => {
    const { deviceId } = req.params;
    if (!DEVICE_FORMAT.test(deviceId)) return res.status(400).json({ error: 'invalid_device_id' });

    const key = req.get('idempotency-key');
    if (!key || !KEY_FORMAT.test(key)) {
      return res
        .status(400)
        .json({ error: 'missing_idempotency_key', message: 'Send an Idempotency-Key header (8-128 chars).' });
    }

    const problems = validateDeviceEvent(req.body);
    if (problems.length) return res.status(422).json({ error: 'invalid_event', problems });

    const hash = requestHash(req.body);

    const outcome = await db.transaction(async (tx) => {
      const claimed = await tx
        .insert(deviceEvents)
        .values({ deviceId, idempotencyKey: key, requestHash: hash, eventType: req.body.type })
        .onConflictDoNothing()
        .returning({ id: deviceEvents.id });

      if (claimed.length === 0) {
        const [prior] = await tx
          .select()
          .from(deviceEvents)
          .where(and(eq(deviceEvents.deviceId, deviceId), eq(deviceEvents.idempotencyKey, key)));
        if (prior.requestHash !== hash) {
          return {
            status: 409,
            body: {
              error: 'idempotency_key_reused',
              message: 'This Idempotency-Key was already used with a different payload.',
            },
          };
        }
        return { status: prior.responseStatus, body: prior.responseBody, replayed: true };
      }

      let status;
      let body;
      try {
        // Savepoint: a refused business rule must not abort the outer
        // transaction, because the refusal itself is stored and replayed.
        ({ status, body } = await tx.transaction((sp) => applyDeviceEvent(sp, deviceId, req.body)));
      } catch (err) {
        if (!(err instanceof HttpError) || err.status >= 500) throw err;
        status = err.status;
        body = err.toBody();
      }

      await tx
        .update(deviceEvents)
        .set({ responseStatus: status, responseBody: body })
        .where(eq(deviceEvents.id, claimed[0].id));
      return { status, body };
    });

    if (outcome.replayed) res.set('Idempotent-Replayed', 'true');
    return res.status(outcome.status).json(outcome.body);
  });

  return router;
}

module.exports = { deviceEventsRouter };
