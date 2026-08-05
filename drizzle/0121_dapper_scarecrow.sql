ALTER TYPE "public"."notification_type" ADD VALUE 'model_mismatch_alert';--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "model_mismatch_alert_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "model_mismatch_alert_exempt" boolean DEFAULT false NOT NULL;