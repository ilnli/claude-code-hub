import type { ExplicitCompactionVersion } from "@/app/v1/_lib/proxy/remote-compaction";
import { getEnvConfig } from "@/lib/config/env.schema";
import { DEFAULT_ENDPOINT_CIRCUIT_BREAKER_CONFIG } from "@/lib/endpoint-circuit-breaker";
import { logger } from "@/lib/logger";
import { getRedisClient } from "./client";

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const EXPIRED_STATE_GRACE_MS = 60 * 1000;

export type CompactionTransportFailureReason = "cf_524" | "first_byte_timeout" | "idle_timeout";

export interface CompactionTransportGap {
  endpointId: number;
  version: ExplicitCompactionVersion;
  reason: CompactionTransportFailureReason;
  createdAt: number;
  expiresAt: number;
}

export type CompactionTransportDecision =
  | { status: "available" }
  | { status: "unavailable"; gap: CompactionTransportGap }
  | { status: "probe"; gap: CompactionTransportGap };

function gapKey(endpointId: number, version: ExplicitCompactionVersion): string {
  return `compaction-transport:${version}:endpoint:${endpointId}`;
}

function leaseKey(endpointId: number, version: ExplicitCompactionVersion): string {
  return `compaction-transport-probe:${version}:endpoint:${endpointId}`;
}

function parseGap(raw: string | null): CompactionTransportGap | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CompactionTransportGap>;
    if (
      !Number.isInteger(parsed.endpointId) ||
      (parsed.version !== "v1" && parsed.version !== "v2") ||
      (parsed.reason !== "cf_524" &&
        parsed.reason !== "first_byte_timeout" &&
        parsed.reason !== "idle_timeout") ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed as CompactionTransportGap;
  } catch {
    return null;
  }
}

export function getCompactionTransportCooldownMs(): number {
  return getEnvConfig().ENABLE_ENDPOINT_CIRCUIT_BREAKER
    ? DEFAULT_ENDPOINT_CIRCUIT_BREAKER_CONFIG.openDuration
    : DEFAULT_COOLDOWN_MS;
}

export async function getCompactionTransportDecision(
  endpointId: number,
  version: ExplicitCompactionVersion
): Promise<CompactionTransportDecision> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (!redis) return { status: "available" };

  try {
    const gap = parseGap(await redis.get(gapKey(endpointId, version)));
    if (!gap) return { status: "available" };
    if (gap.expiresAt > Date.now()) return { status: "unavailable", gap };

    const leaseMs = Math.max(
      getEnvConfig().REMOTE_COMPACTION_VALIDATION_TIMEOUT_MS,
      getEnvConfig().REMOTE_COMPACTION_TRANSPORT_IDLE_TIMEOUT_MS
    );
    const acquired = await redis.set(
      leaseKey(endpointId, version),
      String(Date.now()),
      "PX",
      leaseMs,
      "NX"
    );
    return acquired === "OK" ? { status: "probe", gap } : { status: "unavailable", gap };
  } catch (error) {
    logger.warn("compaction_transport_cache_unavailable", {
      endpointId,
      version,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "available" };
  }
}

export async function rememberCompactionTransportGap(input: {
  endpointId: number;
  version: ExplicitCompactionVersion;
  reason: CompactionTransportFailureReason;
  ttlMs?: number;
}): Promise<void> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (!redis) return;
  const ttlMs = Math.max(1, Math.floor(input.ttlMs ?? getCompactionTransportCooldownMs()));
  const createdAt = Date.now();
  const gap: CompactionTransportGap = {
    endpointId: input.endpointId,
    version: input.version,
    reason: input.reason,
    createdAt,
    expiresAt: createdAt + ttlMs,
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(
      gapKey(input.endpointId, input.version),
      JSON.stringify(gap),
      "PX",
      ttlMs + EXPIRED_STATE_GRACE_MS
    );
    pipeline.del(leaseKey(input.endpointId, input.version));
    await pipeline.exec();
  } catch (error) {
    logger.warn("compaction_transport_cache_unavailable", {
      endpointId: input.endpointId,
      version: input.version,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function clearCompactionTransportGap(
  endpointId: number,
  version: ExplicitCompactionVersion
): Promise<void> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (!redis) return;
  try {
    await redis.del(gapKey(endpointId, version), leaseKey(endpointId, version));
  } catch (error) {
    logger.warn("compaction_transport_cache_unavailable", {
      endpointId,
      version,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
