ALTER TABLE "providers" ADD COLUMN "new_api_access_token" varchar;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "new_api_user_id" integer;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "enable_memory_admission" boolean DEFAULT false NOT NULL;