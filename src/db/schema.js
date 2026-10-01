'use strict';

const { sql } = require('drizzle-orm');
const {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  uuid,
  uniqueIndex,
  index,
  check,
} = require('drizzle-orm/pg-core');

// One row per Stripe PaymentIntent. Status only ever moves forward
// (see src/domain/paymentState.js); the webhook handler never trusts event order.
const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(), // pi_...
    status: text('status').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    // Stripe `created` of the newest event we applied. Kept for audits and
    // for spotting stale deliveries in logs.
    lastEventCreated: bigint('last_event_created', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'payments_status_check',
      sql`${t.status} in ('pending','processing','succeeded','canceled','refunded')`,
    ),
  ],
);

// Every Stripe event id we have handled. The primary key is what makes
// webhook retries and duplicate deliveries a no-op.
const processedEvents = pgTable('processed_events', {
  eventId: text('event_id').primaryKey(), // evt_...
  type: text('type').notNull(),
  objectId: text('object_id'),
  outcome: text('outcome').notNull(), // applied | ignored_stale | ignored_unhandled
  eventCreated: bigint('event_created', { mode: 'number' }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

// One row per (device, idempotency key). The stored response is replayed
// verbatim when a device retries after a dropped connection.
const deviceEvents = pgTable(
  'device_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: text('device_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    eventType: text('event_type').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('device_events_device_key_uq').on(t.deviceId, t.idempotencyKey)],
);

// A physical pour that a payment paid for. Linked to the PaymentIntent by id,
// not by foreign key: a device report can arrive before Stripe's webhook does.
const pourAttempts = pgTable(
  'pour_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: text('device_id').notNull(),
    paymentIntentId: text('payment_intent_id').notNull(),
    state: text('state').notNull(), // DISPENSING | POURED | FAILED | UNKNOWN
    needsReconciliation: boolean('needs_reconciliation').notNull().default(false),
    resolution: text('resolution'), // device_confirmed_poured | operator_confirmed_poured | operator_refunded | device_confirmed_failed
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    refundId: text('refund_id'),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('pour_attempts_state_check', sql`${t.state} in ('DISPENSING','POURED','FAILED','UNKNOWN')`),
    // At most one live or successful pour per payment. An UNKNOWN attempt
    // counts as live, so the database itself refuses a second dispense.
    uniqueIndex('pour_attempts_one_live_per_payment_uq')
      .on(t.paymentIntentId)
      .where(sql`${t.state} in ('DISPENSING','POURED','UNKNOWN')`),
    index('pour_attempts_reconciliation_idx')
      .on(t.createdAt)
      .where(sql`${t.needsReconciliation}`),
  ],
);

// Append-only history of every pour state change and who caused it.
const pourAttemptLog = pgTable(
  'pour_attempt_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attemptId: uuid('attempt_id').notNull(),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    source: text('source').notNull(), // device:<id> | operator:<name>
    note: text('note'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pour_attempt_log_attempt_idx').on(t.attemptId)],
);

module.exports = { payments, processedEvents, deviceEvents, pourAttempts, pourAttemptLog };
