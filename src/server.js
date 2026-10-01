'use strict';

const Stripe = require('stripe');
const { createDb } = require('./db/client');
const { createApp } = require('./app');

const { DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PORT = '3000', HOST = '127.0.0.1' } = process.env;

// This service only ever runs against Stripe test mode.
if (!STRIPE_SECRET_KEY || !STRIPE_SECRET_KEY.startsWith('sk_test_')) {
  console.error('Refusing to start: STRIPE_SECRET_KEY must be a test-mode key (sk_test_...).');
  process.exit(1);
}

const { pool, db } = createDb({ connectionString: DATABASE_URL, max: 10 });
const stripe = new Stripe(STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });
const app = createApp({ db, stripe, webhookSecret: STRIPE_WEBHOOK_SECRET });

const server = app.listen(Number(PORT), HOST, () => {
  console.log(`pour-ledger listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
