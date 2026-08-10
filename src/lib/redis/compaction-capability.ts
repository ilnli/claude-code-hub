import type { ExplicitCompactionVersion } from "@/app/v1/_lib/proxy/remote-compaction";
import { logger } from "@/lib/logger";
import { getRedisClient } from "./client";

const DEFAULT_GAP_TTL_MS = 30 * 60 * 1000;
const EXPIRED_STATE_GRACE_MS = 60 * 1000;
const PROBE_LEASE_MS = 60 * 1000;

export type CompactionCapabilityGapReason = "invalid_response_contract" | "structured_unsupported";

export interface CompactionCapabilityGap {
  providerId: number;
  version: ExplicitCompactionVersion;
  reason: CompactionCapabilityGapReason;
  createdAt: number;
  expiresAt: number;
}

export type CompactionCapabilityDecision =
  | { status: "available" }
  | { status: "unavailable"; gap: CompactionCapabilityGap }
  | { status: "probe"; gap: CompactionCapabilityGap };

function gapKey(providerId: number, version: ExplicitCompactionVersion): string {
  return `compaction-capability:${version}:provider:${providerId}`;
}

function leaseKey(providerId: number, version: ExplicitCompactionVersion): string {
  return `compaction-capability-probe:${version}:provider:${providerId}`;
}

function parseGap(raw: string | null): CompactionCapabilityGap | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CompactionCapabilityGap>;
    if (
      !Number.isInteger(parsed.providerId) ||
      (parsed.version !== "v1" && parsed.version !== "v2") ||
      (parsed.reason !== "invalid_response_contract" &&
        parsed.reason !== "structured_unsupported") ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed as CompactionCapabilityGap;
  } catch {
    return null;
  }
}

export async function getCompactionCapabilityDecision(
  providerId: number,
  version: ExplicitCompactionVersion
): Promise<CompactionCapabilityDecision> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (!redis) return { status: "available" };

  try {
    const gap = parseGap(await redis.get(gapKey(providerId, version)));
    if (!gap) return { status: "available" };
    if (gap.expiresAt > Date.now()) return { status: "unavailable", gap };

    const acquired = await redis.set(
      leaseKey(providerId, version),
      String(Date.now()),
      "PX",
      PROBE_LEASE_MS,
      "NX"
    );
    return acquired === "OK" ? { status: "probe", gap } : { status: "unavailable", gap };
  } catch (error) {
    logger.warn("compaction_capability_cache_unavailable", {
      providerId,
      version,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "available" };
  }
}

export async function rememberCompactionCapabilityGap(input: {
  providerId: number;
  version: ExplicitCompactionVersion;
  reason: CompactionCapabilityGapReason;
  ttlMs?: number | null;
}): Promise<void> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (!redis) return;

  const ttlMs =
    input.ttlMs && Number.isFinite(input.ttlMs) && input.ttlMs > 0
      ? Math.floor(input.ttlMs)
      : DEFAULT_GAP_TTL_MS;
  const createdAt = Date.now();
  const gap: CompactionCapabilityGap = {
    providerId: input.providerId,
    version: input.version,
    reason: input.reason,
    createdAt,
    expiresAt: createdAt + ttlMs,
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(
      gapKey(input.providerId, input.version),
      JSON.stringify(gap),
      "PX",
      ttlMs + EXPIRED_STATE_GRACE_MS
    );
    pipeline.del(leaseKey(input.providerId, input.version));
    await pipeline.exec();
  } catch (error) {
    logger.warn("compaction_capability_cache_unavailable", {
      providerId: input.providerId,
      version: input.version,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function clearCompactionCapabilityGap(
  providerId: number,
  version?: ExplicitCompactionVersion
): Promise<void> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (!redis) return;
  const versions: ExplicitCompactionVersion[] = version ? [version] : ["v1", "v2"];

  try {
    await redis.del(
      ...versions.flatMap((candidate) => [
        gapKey(providerId, candidate),
        leaseKey(providerId, candidate),
      ])
    );
  } catch (error) {
    logger.warn("compaction_capability_cache_unavailable", {
      providerId,
      version,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
