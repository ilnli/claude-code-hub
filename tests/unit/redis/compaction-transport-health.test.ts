import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    pipeline: vi.fn(),
  },
  pipeline: {
    set: vi.fn(),
    del: vi.fn(),
    exec: vi.fn(),
  },
  endpointCircuitEnabled: true,
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: () => mocks.redis,
}));

vi.mock("@/lib/config/env.schema", () => ({
  getEnvConfig: () => ({
    ENABLE_ENDPOINT_CIRCUIT_BREAKER: mocks.endpointCircuitEnabled,
    REMOTE_COMPACTION_VALIDATION_TIMEOUT_MS: 600_000,
    REMOTE_COMPACTION_TRANSPORT_IDLE_TIMEOUT_MS: 90_000,
  }),
}));

vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  DEFAULT_ENDPOINT_CIRCUIT_BREAKER_CONFIG: { openDuration: 300_000 },
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import {
  clearCompactionTransportGap,
  getCompactionTransportDecision,
  rememberCompactionTransportGap,
} from "@/lib/redis/compaction-transport-health";

describe("compaction transport endpoint health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    mocks.endpointCircuitEnabled = true;
    mocks.redis.pipeline.mockReturnValue(mocks.pipeline);
    mocks.pipeline.set.mockReturnValue(mocks.pipeline);
    mocks.pipeline.del.mockReturnValue(mocks.pipeline);
    mocks.pipeline.exec.mockResolvedValue([]);
  });

  it("keys cooldowns by endpoint and compaction version", async () => {
    mocks.redis.get.mockResolvedValue(null);
    await expect(getCompactionTransportDecision(19, "v2")).resolves.toEqual({
      status: "available",
    });
    expect(mocks.redis.get).toHaveBeenCalledWith("compaction-transport:v2:endpoint:19");
  });

  it("uses a single probe lease after cooldown expiry", async () => {
    const gap = {
      endpointId: 19,
      version: "v1",
      reason: "cf_524",
      createdAt: 800_000,
      expiresAt: 900_000,
    };
    mocks.redis.get.mockResolvedValue(JSON.stringify(gap));
    mocks.redis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await expect(getCompactionTransportDecision(19, "v1")).resolves.toEqual({
      status: "probe",
      gap,
    });
    await expect(getCompactionTransportDecision(19, "v1")).resolves.toEqual({
      status: "unavailable",
      gap,
    });
    expect(mocks.redis.set).toHaveBeenCalledWith(
      "compaction-transport-probe:v1:endpoint:19",
      "1000000",
      "PX",
      600_000,
      "NX"
    );
  });

  it("uses endpoint circuit duration or thirty minutes when disabled", async () => {
    await rememberCompactionTransportGap({ endpointId: 3, version: "v2", reason: "idle_timeout" });
    expect(mocks.pipeline.set.mock.calls[0]?.[3]).toBe(360_000);

    mocks.endpointCircuitEnabled = false;
    await rememberCompactionTransportGap({ endpointId: 3, version: "v1", reason: "cf_524" });
    expect(mocks.pipeline.set.mock.calls[1]?.[3]).toBe(1_860_000);
  });

  it("clears the version-specific gap and lease", async () => {
    mocks.redis.del.mockResolvedValue(2);
    await clearCompactionTransportGap(7, "v2");
    expect(mocks.redis.del).toHaveBeenCalledWith(
      "compaction-transport:v2:endpoint:7",
      "compaction-transport-probe:v2:endpoint:7"
    );
  });
});
