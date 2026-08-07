ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "recharge_settlement_alert_enabled" boolean DEFAULT false NOT NULL;
