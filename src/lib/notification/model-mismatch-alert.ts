import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis/client";
import type { ModelMismatchAlertData, ModelMismatchPair } from "@/lib/webhook";

export const MODEL_MISMATCH_ALERT_COOLDOWN_MINUTES = 10;
const COOLDOWN_SECONDS = MODEL_MISMATCH_ALERT_COOLDOWN_MINUTES * 60;

interface RedisEvalClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface ModelMismatchOccurrence {
  providerId: number;
  providerName: string;
  requestedModel: string;
  actualResponseModel: string;
  modelMismatchAlertExempt?: boolean;
  occurredAt?: Date;
}

interface AggregationResult {
  shouldNotify: boolean;
  payload?: ModelMismatchAlertData;
}

const AGGREGATE_MODEL_MISMATCH_LUA = `
local cooldown_key = KEYS[1]
local pending_count_key = KEYS[2]
local pending_pairs_key = KEYS[3]
local last_sent_key = KEYS[4]
local pair_json = ARGV[1]
local now_iso = ARGV[2]
local cooldown_seconds = tonumber(ARGV[3])

if redis.call("EXISTS", cooldown_key) == 1 then
  local pending_count = redis.call("INCR", pending_count_key)
  redis.call("SADD", pending_pairs_key, pair_json)
  return {0, tostring(pending_count)}
end

local pending_count = tonumber(redis.call("GET", pending_count_key) or "0")
local pending_pairs = redis.call("SMEMBERS", pending_pairs_key)
local previous_sent_at = redis.call("GET", last_sent_key) or ""

redis.call("DEL", pending_count_key, pending_pairs_key)
redis.call("SET", cooldown_key, now_iso, "EX", cooldown_seconds)
redis.call("SET", last_sent_key, now_iso)

local result = {1, tostring(pending_count + 1), previous_sent_at}
for _, stored_pair in ipairs(pending_pairs) do
  table.insert(result, stored_pair)
end
return result
`;

function aggregationKeys(providerId: number): [string, string, string, string] {
  const prefix = `model-mismatch-alert:{${providerId}}`;
  return [
    `${prefix}:cooldown`,
    `${prefix}:pending-count`,
    `${prefix}:pending-pairs`,
    `${prefix}:last-sent-at`,
  ];
}

function parseStoredPair(value: unknown): ModelMismatchPair | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Partial<ModelMismatchPair>;
    if (
      typeof parsed.requestedModel !== "string" ||
      typeof parsed.actualResponseModel !== "string"
    ) {
      return null;
    }
    return {
      requestedModel: parsed.requestedModel,
      actualResponseModel: parsed.actualResponseModel,
    };
  } catch {
    return null;
  }
}

function uniquePairs(pairs: ModelMismatchPair[]): ModelMismatchPair[] {
  const seen = new Set<string>();
  return pairs.filter((pair) => {
    const key = JSON.stringify([pair.requestedModel, pair.actualResponseModel]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function aggregateModelMismatchOccurrence(
  redis: RedisEvalClient,
  occurrence: ModelMismatchOccurrence
): Promise<AggregationResult> {
  const occurredAt = occurrence.occurredAt ?? new Date();
  const nowIso = occurredAt.toISOString();
  const currentPair: ModelMismatchPair = {
    requestedModel: occurrence.requestedModel,
    actualResponseModel: occurrence.actualResponseModel,
  };
  const keys = aggregationKeys(occurrence.providerId);
  const raw = await redis.eval(
    AGGREGATE_MODEL_MISMATCH_LUA,
    keys.length,
    ...keys,
    JSON.stringify(currentPair),
    nowIso,
    COOLDOWN_SECONDS
  );

  if (!Array.isArray(raw) || Number(raw[0]) !== 1) {
    return { shouldNotify: false };
  }

  const occurrenceCount = Number(raw[1]);
  const previousSentAt = typeof raw[2] === "string" && raw[2] ? raw[2] : nowIso;
  const storedPairs = raw
    .slice(3)
    .map(parseStoredPair)
    .filter((pair) => pair !== null);

  return {
    shouldNotify: true,
    payload: {
      providerId: occurrence.providerId,
      providerName: occurrence.providerName,
      occurrenceCount: Number.isFinite(occurrenceCount) ? occurrenceCount : 1,
      mismatches: uniquePairs([...storedPairs, currentPair]),
      windowStart: previousSentAt,
      windowEnd: nowIso,
      cooldownMinutes: MODEL_MISMATCH_ALERT_COOLDOWN_MINUTES,
      generatedAt: nowIso,
    },
  };
}

export async function recordModelMismatch(occurrence: ModelMismatchOccurrence): Promise<void> {
  const requestedModel = occurrence.requestedModel.trim();
  const actualResponseModel = occurrence.actualResponseModel.trim();
  if (
    occurrence.modelMismatchAlertExempt ||
    !requestedModel ||
    !actualResponseModel ||
    requestedModel === actualResponseModel
  ) {
    return;
  }

  try {
    const { getNotificationSettings } = await import("@/repository/notifications");
    const settings = await getNotificationSettings();
    if (!settings.enabled || !settings.modelMismatchAlertEnabled || settings.useLegacyMode) {
      return;
    }

    const { getEnabledBindingsByType } = await import("@/repository/notification-bindings");
    const bindings = await getEnabledBindingsByType("model_mismatch_alert");
    if (bindings.length === 0) {
      logger.info({
        action: "model_mismatch_alert_skipped",
        providerId: occurrence.providerId,
        reason: "no_bindings",
      });
      return;
    }

    const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
    if (!redis) {
      logger.warn({
        action: "model_mismatch_alert_skipped",
        providerId: occurrence.providerId,
        reason: "redis_unavailable",
      });
      return;
    }

    const aggregated = await aggregateModelMismatchOccurrence(redis, {
      ...occurrence,
      requestedModel,
      actualResponseModel,
    });
    if (!aggregated.shouldNotify || !aggregated.payload) return;

    const { addNotificationJobForTarget } = await import("./notification-queue");
    for (const binding of bindings) {
      await addNotificationJobForTarget(
        "model-mismatch-alert",
        binding.targetId,
        binding.id,
        aggregated.payload
      );
    }

    logger.info({
      action: "model_mismatch_alert_enqueued",
      providerId: occurrence.providerId,
      occurrenceCount: aggregated.payload.occurrenceCount,
      mismatches: aggregated.payload.mismatches.length,
      targets: bindings.length,
    });
  } catch (error) {
    logger.error({
      action: "model_mismatch_alert_error",
      providerId: occurrence.providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
