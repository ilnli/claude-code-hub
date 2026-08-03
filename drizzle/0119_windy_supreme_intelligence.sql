ALTER TABLE "providers" ADD COLUMN "rate_follow_upstream" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "rate_default_multiplier" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "rate_markup_type" varchar(10) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "rate_markup_value" numeric(10, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "upstream_rate_multiplier" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "upstream_rate_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "upstream_billing_probe_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "upstream_billing_probe_interval_minutes" integer DEFAULT 30 NOT NULL;