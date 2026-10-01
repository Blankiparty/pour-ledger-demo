'use strict';

const express = require('express');
const { stripeWebhookRouter } = require('./routes/stripeWebhook');
const { deviceEventsRouter } = require('./routes/deviceEvents');
const { reconciliationRouter } = require('./routes/reconciliation');
const { HttpError } = require('./httpError');

/**
 * Build the Express app. Dependencies are passed in so tests can use a
 * per-file Postgres schema and a Stripe client that never touches the network.
 */
function createApp({ db, stripe, webhookSecret }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // The webhook router parses its own raw body. No global JSON parser runs
  // before it, otherwise the signature check would see re-serialised bytes.
  app.use('/webhooks/stripe', stripeWebhookRouter({ db, stripe, webhookSecret }));
  app.use('/devices', deviceEventsRouter({ db }));
  // Operator routes. In the real service these sit behind staff auth.
  app.use('/reconciliation', reconciliationRouter({ db, stripe }));

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json(err.toBody());
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (process.env.NODE_ENV !== 'test') console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

module.exports = { createApp };
