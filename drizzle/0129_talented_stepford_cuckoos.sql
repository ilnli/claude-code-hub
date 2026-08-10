CREATE TABLE IF NOT EXISTS "usage_attempt_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"attempt_ordinal" integer NOT NULL,
	"provider_id" integer NOT NULL,
	"provider_endpoint_id" integer,
	"model" varchar(128),
	"compaction_version" varchar(2) NOT NULL,
	"returned_usage" boolean DEFAULT false NOT NULL,
	"usage_source" varchar(32),
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cache_creation_input_tokens" bigint,
	"cache_read_input_tokens" bigint,
	"cache_creation_5m_input_tokens" bigint,
	"cache_creation_1h_input_tokens" bigint,
	"reasoning_tokens" bigint,
	"pricing_effective_at" timestamp with time zone,
	"price_source" varchar(64),
	"price_snapshot" jsonb,
	"cost_multiplier" numeric(10, 4),
	"group_cost_multiplier" numeric(10, 4),
	"cost_usd" numeric(21, 15) DEFAULT '0' NOT NULL,
	"pricing_state" varchar(20) NOT NULL,
	"validation_outcome" varchar(20) NOT NULL,
	"validation_reason" varchar(64),
	"response_bytes" integer DEFAULT 0 NOT NULL,
	"transport" varchar(16) NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "compaction_version" varchar(2);--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "billing_state" varchar(20) DEFAULT 'sealed' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN IF NOT EXISTS "compaction_version" varchar(2);--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN IF NOT EXISTS "billing_state" varchar(20) DEFAULT 'sealed' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_usage_attempt_ledger_request_ordinal" ON "usage_attempt_ledger" USING btree ("request_id","attempt_ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_usage_attempt_ledger_provider_created_at" ON "usage_attempt_ledger" USING btree ("provider_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_usage_attempt_ledger_request" ON "usage_attempt_ledger" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_usage_attempt_ledger_pricing_pending" ON "usage_attempt_ledger" USING btree ("created_at") WHERE "usage_attempt_ledger"."pricing_state" = 'pricing_pending';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fn_upsert_usage_ledger()
RETURNS TRIGGER AS $$
DECLARE
  v_final_provider_id integer;
  v_is_success boolean;
  v_success_rate_outcome varchar;
BEGIN
  v_success_rate_outcome := fn_compute_message_request_success_rate_outcome(
    NEW.blocked_by,
    NEW.status_code,
    NEW.error_message,
    NEW.provider_chain
  );

  IF NEW.blocked_by = 'warmup' THEN
    -- If a ledger row already exists (row was originally non-warmup), mark it as warmup
    -- and sync the latest actual_response_model so audit stays consistent across tables.
    UPDATE usage_ledger
    SET blocked_by = 'warmup',
        success_rate_outcome = v_success_rate_outcome,
        actual_response_model = NEW.actual_response_model
    WHERE request_id = NEW.id;
    RETURN NEW;
  END IF;

  IF LOWER(REGEXP_REPLACE(COALESCE(NEW.endpoint, ''), '/+$', ''))
    IN ('/v1/messages/count_tokens') THEN
    DELETE FROM usage_ledger WHERE request_id = NEW.id;
    RETURN NEW;
  END IF;

  IF NEW.provider_chain IS NOT NULL
     AND jsonb_typeof(NEW.provider_chain) = 'array'
     AND jsonb_array_length(NEW.provider_chain) > 0
     AND jsonb_typeof(NEW.provider_chain -> -1) = 'object'
     AND (NEW.provider_chain -> -1 ? 'id')
     AND (NEW.provider_chain -> -1 ->> 'id') ~ '^[0-9]+$' THEN
    v_final_provider_id := (NEW.provider_chain -> -1 ->> 'id')::integer;
  ELSE
    v_final_provider_id := NEW.provider_id;
  END IF;

  v_is_success := (NEW.error_message IS NULL OR NEW.error_message = '')
                  AND (NEW.status_code IS NULL OR NEW.status_code < 400);

  INSERT INTO usage_ledger (
    request_id, user_id, key, provider_id, final_provider_id,
    model, original_model, actual_response_model, endpoint, compaction_version,
    billing_state, api_type, session_id,
    session_identity, session_identity_kind, affinity_scope_tag,
    affinity_fingerprint, affinity_fingerprint_chain, is_replay, replay_source_request_id,
    status_code, is_success, success_rate_outcome, blocked_by,
    cost_usd, cost_multiplier, group_cost_multiplier,
    input_tokens, output_tokens,
    cache_creation_input_tokens, cache_read_input_tokens,
    cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
    cache_ttl_applied, context_1m_applied, swap_cache_ttl_applied,
    duration_ms, ttfb_ms, first_byte_ms, client_ip, created_at
  ) VALUES (
    NEW.id, NEW.user_id, NEW.key, NEW.provider_id, v_final_provider_id,
    NEW.model, NEW.original_model, NEW.actual_response_model, NEW.endpoint,
    NEW.compaction_version, NEW.billing_state, NEW.api_type, NEW.session_id,
    NEW.session_identity, NEW.session_identity_kind, NEW.affinity_scope_tag,
    NEW.affinity_fingerprint, NEW.affinity_fingerprint_chain, NEW.is_replay, NEW.replay_source_request_id,
    NEW.status_code, v_is_success, v_success_rate_outcome, NEW.blocked_by,
    CASE WHEN NEW.is_replay THEN 0 ELSE NEW.cost_usd END,
    NEW.cost_multiplier, NEW.group_cost_multiplier,
    NEW.input_tokens, NEW.output_tokens,
    NEW.cache_creation_input_tokens, NEW.cache_read_input_tokens,
    NEW.cache_creation_5m_input_tokens, NEW.cache_creation_1h_input_tokens,
    NEW.cache_ttl_applied, NEW.context_1m_applied, NEW.swap_cache_ttl_applied,
    NEW.duration_ms, NEW.ttfb_ms, NEW.first_byte_ms, NEW.client_ip, NEW.created_at
  )
  ON CONFLICT (request_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    key = EXCLUDED.key,
    provider_id = EXCLUDED.provider_id,
    final_provider_id = EXCLUDED.final_provider_id,
    model = EXCLUDED.model,
    original_model = EXCLUDED.original_model,
    actual_response_model = EXCLUDED.actual_response_model,
    endpoint = EXCLUDED.endpoint,
    compaction_version = EXCLUDED.compaction_version,
    billing_state = EXCLUDED.billing_state,
    api_type = EXCLUDED.api_type,
    session_id = EXCLUDED.session_id,
    session_identity = EXCLUDED.session_identity,
    session_identity_kind = EXCLUDED.session_identity_kind,
    affinity_scope_tag = EXCLUDED.affinity_scope_tag,
    affinity_fingerprint = EXCLUDED.affinity_fingerprint,
    affinity_fingerprint_chain = EXCLUDED.affinity_fingerprint_chain,
    is_replay = EXCLUDED.is_replay,
    replay_source_request_id = EXCLUDED.replay_source_request_id,
    status_code = EXCLUDED.status_code,
    is_success = EXCLUDED.is_success,
    success_rate_outcome = EXCLUDED.success_rate_outcome,
    blocked_by = EXCLUDED.blocked_by,
    cost_usd = EXCLUDED.cost_usd,
    cost_multiplier = EXCLUDED.cost_multiplier,
    group_cost_multiplier = EXCLUDED.group_cost_multiplier,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
    cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
    cache_creation_5m_input_tokens = EXCLUDED.cache_creation_5m_input_tokens,
    cache_creation_1h_input_tokens = EXCLUDED.cache_creation_1h_input_tokens,
    cache_ttl_applied = EXCLUDED.cache_ttl_applied,
    context_1m_applied = EXCLUDED.context_1m_applied,
    swap_cache_ttl_applied = EXCLUDED.swap_cache_ttl_applied,
    duration_ms = EXCLUDED.duration_ms,
    ttfb_ms = EXCLUDED.ttfb_ms,
    first_byte_ms = EXCLUDED.first_byte_ms,
    client_ip = EXCLUDED.client_ip;
    -- created_at deliberately NOT updated on conflict: it represents the
    -- original insert time of the ledger row, which is immutable by design.

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_upsert_usage_ledger failed for request_id=%: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_upsert_usage_ledger ON message_request;

CREATE TRIGGER trg_upsert_usage_ledger
AFTER INSERT OR UPDATE OF
  blocked_by,
  status_code,
  error_message,
  provider_chain,
  actual_response_model,
  endpoint,
  compaction_version,
  billing_state,
  provider_id,
  user_id,
  "key",
  model,
  original_model,
  api_type,
  session_id,
  session_identity,
  session_identity_kind,
  affinity_scope_tag,
  affinity_fingerprint,
  affinity_fingerprint_chain,
  is_replay,
  replay_source_request_id,
  cost_usd,
  cost_multiplier,
  group_cost_multiplier,
  input_tokens,
  output_tokens,
  cache_creation_input_tokens,
  cache_read_input_tokens,
  cache_creation_5m_input_tokens,
  cache_creation_1h_input_tokens,
  cache_ttl_applied,
  context_1m_applied,
  swap_cache_ttl_applied,
  duration_ms,
  ttfb_ms,
  first_byte_ms,
  client_ip,
  created_at
ON message_request
FOR EACH ROW
EXECUTE FUNCTION fn_upsert_usage_ledger();
