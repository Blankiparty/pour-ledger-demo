CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"last_event_created" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" in ('pending','processing','succeeded','canceled','refunded'))
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"object_id" text,
	"outcome" text NOT NULL,
	"event_created" bigint NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"event_type" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pour_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"state" text NOT NULL,
	"needs_reconciliation" boolean DEFAULT false NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"refund_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pour_attempts_state_check" CHECK ("pour_attempts"."state" in ('DISPENSING','POURED','FAILED','UNKNOWN'))
);
--> statement-breakpoint
CREATE TABLE "pour_attempt_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "device_events_device_key_uq" ON "device_events" USING btree ("device_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pour_attempts_one_live_per_payment_uq" ON "pour_attempts" USING btree ("payment_intent_id") WHERE "pour_attempts"."state" in ('DISPENSING','POURED','UNKNOWN');--> statement-breakpoint
CREATE INDEX "pour_attempts_reconciliation_idx" ON "pour_attempts" USING btree ("created_at") WHERE "pour_attempts"."needs_reconciliation";--> statement-breakpoint
CREATE INDEX "pour_attempt_log_attempt_idx" ON "pour_attempt_log" USING btree ("attempt_id");