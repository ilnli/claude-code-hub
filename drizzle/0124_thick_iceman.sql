DO $$ BEGIN
  CREATE TYPE "public"."recharge_order_status" AS ENUM('pending', 'processing', 'cancelled', 'completed', 'manual_closed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'recharge_settlement_alert';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_config_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"app_id" varchar(64) NOT NULL,
	"private_key" text NOT NULL,
	"alipay_public_key" text NOT NULL,
	"product_name" varchar(256) NOT NULL,
	"notify_domain" varchar(512),
	"fee_rate_percent" numeric(6, 4) DEFAULT '0' NOT NULL,
	"min_credit_usd" numeric(10, 2) DEFAULT '1' NOT NULL,
	"max_credit_usd" numeric(10, 2) DEFAULT '1000' NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_config_fee_rate_check" CHECK ("payment_config_versions"."fee_rate_percent" >= 0 AND "payment_config_versions"."fee_rate_percent" < 100),
	CONSTRAINT "payment_config_credit_range_check" CHECK ("payment_config_versions"."min_credit_usd" > 0 AND "payment_config_versions"."max_credit_usd" >= "payment_config_versions"."min_credit_usd")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recharge_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_no" varchar(64) NOT NULL,
	"config_version_id" integer NOT NULL,
	"key_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"key_name" varchar NOT NULL,
	"user_name" varchar NOT NULL,
	"status" "recharge_order_status" DEFAULT 'pending' NOT NULL,
	"credit_usd" numeric(10, 2) NOT NULL,
	"paid_amount_cny" numeric(10, 2) NOT NULL,
	"fee_rate_percent" numeric(6, 4) NOT NULL,
	"product_name" varchar(256) NOT NULL,
	"qr_code" text,
	"alipay_trade_no" varchar(128),
	"key_credit_applied_usd" numeric(10, 2) DEFAULT '0' NOT NULL,
	"user_credit_applied_usd" numeric(10, 2) DEFAULT '0' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_settlement_error" text,
	"cancellation_reason" varchar(64),
	"manual_reason" text,
	"manual_operator_user_id" integer,
	"alert_sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "recharge_orders" ADD CONSTRAINT "recharge_orders_config_version_id_payment_config_versions_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "public"."payment_config_versions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payment_config_active" ON "payment_config_versions" USING btree ("is_active") WHERE "payment_config_versions"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_recharge_orders_order_no" ON "recharge_orders" USING btree ("order_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_recharge_orders_alipay_trade_no" ON "recharge_orders" USING btree ("alipay_trade_no") WHERE "recharge_orders"."alipay_trade_no" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_recharge_orders_pending_key" ON "recharge_orders" USING btree ("key_id") WHERE "recharge_orders"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recharge_orders_key_created" ON "recharge_orders" USING btree ("key_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recharge_orders_status_created" ON "recharge_orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recharge_orders_retry" ON "recharge_orders" USING btree ("next_retry_at") WHERE "recharge_orders"."status" = 'processing' AND "recharge_orders"."next_retry_at" IS NOT NULL;
