ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'weight_adjustment_alert';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_weight_adjustment_rule_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"provider_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_weight_adjustment_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"provider_type" varchar(20) NOT NULL,
	"priority" integer NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"next_run_at" timestamp with time zone,
	"active_run_id" integer,
	"fault_active" boolean DEFAULT false NOT NULL,
	"fault_kind" varchar(40),
	"fault_message" text,
	"fault_started_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_weight_adjustment_run_details" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"provider_id" integer NOT NULL,
	"provider_name" varchar NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"cost_multiplier" numeric(20, 10),
	"previous_weight" integer NOT NULL,
	"projected_weight" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_weight_adjustment_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"trigger" varchar(16) NOT NULL,
	"status" varchar(32) NOT NULL,
	"idempotency_key" varchar(200),
	"rule_name" varchar(128) NOT NULL,
	"provider_type" varchar(20) NOT NULL,
	"priority" integer NOT NULL,
	"rule_revision" integer NOT NULL,
	"summary" jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "weight_adjustment_alert_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "provider_weight_adjustment_interval_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_weight_adjustment_rule_members" ADD CONSTRAINT "provider_weight_adjustment_rule_members_rule_id_provider_weight_adjustment_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."provider_weight_adjustment_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_weight_adjustment_rule_members" ADD CONSTRAINT "provider_weight_adjustment_rule_members_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_weight_adjustment_run_details" ADD CONSTRAINT "provider_weight_adjustment_run_details_run_id_provider_weight_adjustment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."provider_weight_adjustment_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_weight_adjustment_runs" ADD CONSTRAINT "provider_weight_adjustment_runs_rule_id_provider_weight_adjustment_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."provider_weight_adjustment_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_provider_weight_adjustment_rule_members_provider" ON "provider_weight_adjustment_rule_members" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_provider_weight_adjustment_rule_members_rule_provider" ON "provider_weight_adjustment_rule_members" USING btree ("rule_id","provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_weight_adjustment_rule_members_rule" ON "provider_weight_adjustment_rule_members" USING btree ("rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_provider_weight_adjustment_rules_active_name" ON "provider_weight_adjustment_rules" USING btree ("name") WHERE "provider_weight_adjustment_rules"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_weight_adjustment_rules_due" ON "provider_weight_adjustment_rules" USING btree ("is_enabled","next_run_at") WHERE "provider_weight_adjustment_rules"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_weight_adjustment_run_details_run" ON "provider_weight_adjustment_run_details" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_provider_weight_adjustment_runs_manual_idempotency" ON "provider_weight_adjustment_runs" USING btree ("rule_id","idempotency_key") WHERE "provider_weight_adjustment_runs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_provider_weight_adjustment_runs_active_rule" ON "provider_weight_adjustment_runs" USING btree ("rule_id") WHERE "provider_weight_adjustment_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_weight_adjustment_runs_rule_started" ON "provider_weight_adjustment_runs" USING btree ("rule_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_weight_adjustment_runs_expires" ON "provider_weight_adjustment_runs" USING btree ("expires_at");
