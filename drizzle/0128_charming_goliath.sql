CREATE TABLE IF NOT EXISTS "upstream_sites" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_key" varchar(255) NOT NULL,
	"probe_base_url" text,
	"dashboard_pat" text,
	"allow_insecure_http" boolean DEFAULT false NOT NULL,
	"proxy_url" text,
	"proxy_fallback_to_direct" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "upstream_site_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_upstream_sites_site_key" ON "upstream_sites" USING btree ("site_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_upstream_sites_created_at" ON "upstream_sites" USING btree ("created_at");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "providers" ADD CONSTRAINT "providers_upstream_site_id_upstream_sites_id_fk" FOREIGN KEY ("upstream_site_id") REFERENCES "public"."upstream_sites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_providers_upstream_site" ON "providers" USING btree ("upstream_site_id") WHERE "providers"."deleted_at" IS NULL;
