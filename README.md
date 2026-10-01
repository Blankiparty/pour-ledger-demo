# pour-ledger-demo

A small payments and pour ledger for self-serve coffee stations. It shows four things a money-moving backend has to get right, each with tests that run against a real PostgreSQL 16:

1. **CI that is deterministic.** GitHub Actions starts a `postgres:16` service, applies the migrations, and runs Jest split across 2 shards. Every test file gets its own Postgres schema, so files and shards never share rows.
2. **Stripe webhooks that are safe to receive twice, or in the wrong order.** The signature is checked on the raw body. Each event id is recorded once. The PaymentIntent is re-fetched from Stripe and our row only moves along allowed transitions, so a late event can't undo a newer state.
3. **Device events that are safe to retry.** Stations send a key they generate once per event. A retry with the same payload gets the original response back; the same key with a different payload gets a 409.
4. **"Payment approved, but pour result unknown."** The backend records the attempt as `UNKNOWN`, linked to the PaymentIntent, and flags it for reconciliation. It never refunds on its own, never allows a second dispense for that payment, and never marks it poured. It waits for the station's later report or an operator's decision.

Sample data only. Stripe runs in test mode with fakes; no network calls are made in tests.

## Stack

Node 20, Express 5, PostgreSQL 16, Drizzle ORM (schema + migrations), Jest, Supertest, Stripe Node SDK.

## Run the tests

**Option A: no Docker, no local Postgres.** This starts a throwaway PostgreSQL 16 on `127.0.0.1` (via `embedded-postgres`), applies the migrations, runs Jest, then stops the server and deletes its data.

    npm ci
    npm run test:local
    npm run test:local -- --shard=1/2     # the same split CI uses

**Option B: your own disposable Postgres on 127.0.0.1.**

    export DATABASE_URL=postgres://pour:pour@127.0.0.1:5432/pour_ledger_test
    npm run db:migrate
    npm test

The test harness refuses any `DATABASE_URL` that is not on `127.0.0.1` / `localhost`, because it creates and drops schemas.

## Run the server

    cp .env.example .env    # fill in test-mode values
    npm run db:migrate
    npm start

The server refuses to start with anything but an `sk_test_` Stripe key and binds to `127.0.0.1` by default.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| POST | `/webhooks/stripe` | Stripe events (raw body, signature checked) |
| POST | `/devices/:deviceId/events` | Station events, `Idempotency-Key` header required |
| GET | `/reconciliation` | Pours waiting for a decision, with payment status |
| POST | `/reconciliation/:attemptId/resolve` | Operator decision: `confirm_poured` or `refund` |

Device event types: `pour.started`, `pour.completed`, `pour.failed`, `pour.unknown`.

## How it works

**Payments** (`src/routes/stripeWebhook.js`, `src/domain/paymentState.js`)

- `express.raw()` on the webhook route only, then `stripe.webhooks.constructEvent()`. Bad, missing or stale (older than 5 minutes) signatures get a 400.
- `processed_events.event_id` is the primary key. Redeliveries return 200 and change nothing, including five deliveries of one event at the same moment.
- The handler doesn't trust the event payload. It re-fetches the PaymentIntent (with `latest_charge`) and applies a transition table: `succeeded` can only become `refunded`, and `canceled` / `refunded` are final.
- The event record and the state change are written in one transaction. If Stripe can't be reached, we return 500, nothing is recorded, and Stripe's retry gets a clean run.

**Device ingest** (`src/routes/deviceEvents.js`)

- `unique (device_id, idempotency_key)`. The request is claimed with `INSERT ... ON CONFLICT DO NOTHING`. The SHA-256 of the canonical JSON body (sorted keys) decides "same payload".
- The response is stored next to the key in the same transaction, so a replay returns exactly what the first call returned (header `Idempotent-Replayed: true`).
- Concurrent retries wait on the unique index and then replay; ten parallel copies create one attempt.
- A business refusal (for example a second dispense) is stored and replayed too. A 5xx rolls back, so the retry starts clean.

**Unknown pours** (`src/domain/pours.js`, `src/routes/reconciliation.js`)

- `pour_attempts` has a partial unique index: one `DISPENSING` / `POURED` / `UNKNOWN` attempt per PaymentIntent. A second dispense is refused by the database, not only by app code.
- `UNKNOWN` can only become `POURED` or `FAILED`, and only through the station's report or an operator. No timer, sweeper or webhook moves it.
- The only refund path in the service is the operator's `refund` decision. It uses a Stripe idempotency key tied to the attempt, so a double click can't refund twice. The payment row turns `refunded` when Stripe's `charge.refunded` webhook confirms it.
- Every state change is written to `pour_attempt_log` with its source (`device:<id>` or `operator:<name>`).

## Test layout

| File | Covers |
|---|---|
| `test/stripeWebhook.test.js` | signatures, duplicates, concurrency, out-of-order, Stripe outage |
| `test/deviceIngest.test.js` | idempotency keys, replay, 409 on reuse, concurrent retries |
| `test/pourUnknown.test.js` | each "never" rule, reconciliation, operator decisions |
| `test/stateMachines.test.js` | transition tables, request hashing |
| `test/isolation.test.js` | the per-file schema harness itself |

## Out of scope for the demo

Device authentication (mTLS or signed requests), staff auth on the reconciliation routes, partial refunds, and deployment.
