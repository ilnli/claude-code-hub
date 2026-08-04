ALTER TABLE "providers" ADD COLUMN "rate_upstream_type" varchar(10) DEFAULT 'sub2api' NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "newapi_group" varchar(64);--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "newapi_detected_group" varchar(64);