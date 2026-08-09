CREATE TABLE IF NOT EXISTS "client_version_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_type" varchar(128) NOT NULL,
	"mode" varchar(32) NOT NULL,
	"minimum_version" varchar(64),
	"maximum_version" varchar(64),
	"baseline_lag" integer,
	"automatic_baseline" varchar(64),
	"previous_series_terminal_version" varchar(64),
	"baseline_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_version_policies_mode_check" CHECK ("client_version_policies"."mode" IN ('automatic_baseline', 'minimum', 'maximum', 'range', 'baseline_lag')),
	CONSTRAINT "client_version_policies_shape_check" CHECK ((
        ("client_version_policies"."mode" = 'automatic_baseline' AND "client_version_policies"."minimum_version" IS NULL AND "client_version_policies"."maximum_version" IS NULL AND "client_version_policies"."baseline_lag" IS NULL)
        OR ("client_version_policies"."mode" = 'minimum' AND "client_version_policies"."minimum_version" IS NOT NULL AND "client_version_policies"."maximum_version" IS NULL AND "client_version_policies"."baseline_lag" IS NULL)
        OR ("client_version_policies"."mode" = 'maximum' AND "client_version_policies"."minimum_version" IS NULL AND "client_version_policies"."maximum_version" IS NOT NULL AND "client_version_policies"."baseline_lag" IS NULL)
        OR ("client_version_policies"."mode" = 'range' AND "client_version_policies"."minimum_version" IS NOT NULL AND "client_version_policies"."maximum_version" IS NOT NULL AND "client_version_policies"."baseline_lag" IS NULL)
        OR ("client_version_policies"."mode" = 'baseline_lag' AND "client_version_policies"."minimum_version" IS NULL AND "client_version_policies"."maximum_version" IS NULL AND "client_version_policies"."baseline_lag" > 0)
      ))
);
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "client_version_policy_initialized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_client_version_policies_client_type_unique" ON "client_version_policies" USING btree ("client_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_client_version_policies_mode" ON "client_version_policies" USING btree ("mode");
