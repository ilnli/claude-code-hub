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
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: () => mocks.redis,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn() },
}));

import {
  clearCompactionCapabilityGap,
  getCompactionCapabilityDecision,
  rememberCompactionCapabilityGap,
} from "@/lib/redis/compaction-capability";

describe("compaction capability memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    mocks.redis.pipeline.mockReturnValue(mocks.pipeline);
    mocks.pipeline.set.mockReturnValue(mocks.pipeline);
    mocks.pipeline.del.mockReturnValue(mocks.pipeline);
    mocks.pipeline.exec.mockResolvedValue([]);
  });

  it("keeps provider and protocol version in the capability key", async () => {
    mocks.redis.get.mockResolvedValue(null);

    await expect(getCompactionCapabilityDecision(17, "v2")).resolves.toEqual({
      status: "available",
    });

    expect(mocks.redis.get).toHaveBeenCalledWith("compaction-capability:v2:provider:17");
  });

  it("skips a provider while its capability gap is active", async () => {
    const gap = {
      providerId: 4,
      version: "v1",
      reason: "invalid_response_contract",
      createdAt: 900_000,
      expiresAt: 1_100_000,
    };
    mocks.redis.get.mockResolvedValue(JSON.stringify(gap));

    await expect(getCompactionCapabilityDecision(4, "v1")).resolves.toEqual({
      status: "unavailable",
      gap,
    });
    expect(mocks.redis.set).not.toHaveBeenCalled();
  });

  it("allows one probe after expiry and makes concurrent requests skip", async () => {
    const gap = {
      providerId: 4,
      version: "v1",
      reason: "invalid_response_contract",
      createdAt: 800_000,
      expiresAt: 900_000,
    };
    mocks.redis.get.mockResolvedValue(JSON.stringify(gap));
    mocks.redis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await expect(getCompactionCapabilityDecision(4, "v1")).resolves.toEqual({
      status: "probe",
      gap,
    });
    await expect(getCompactionCapabilityDecision(4, "v1")).resolves.toEqual({
      status: "unavailable",
      gap,
    });
    expect(mocks.redis.set).toHaveBeenCalledWith(
      "compaction-capability-probe:v1:provider:4",
      "1000000",
      "PX",
      600_000,
      "NX"
    );
  });

  it("uses the provider circuit duration and falls back to thirty minutes", async () => {
    await rememberCompactionCapabilityGap({
      providerId: 9,
      version: "v2",
      reason: "invalid_response_contract",
      ttlMs: 120_000,
    });
    expect(mocks.pipeline.set.mock.calls[0]?.[3]).toBe(180_000);

    await rememberCompactionCapabilityGap({
      providerId: 9,
      version: "v1",
      reason: "structured_unsupported",
      ttlMs: 0,
    });
    expect(mocks.pipeline.set.mock.calls[1]?.[3]).toBe(1_860_000);
  });

  it("clears both versions when no version is specified", async () => {
    mocks.redis.del.mockResolvedValue(4);

    await clearCompactionCapabilityGap(12);

    expect(mocks.redis.del).toHaveBeenCalledWith(
      "compaction-capability:v1:provider:12",
      "compaction-capability-probe:v1:provider:12",
      "compaction-capability:v2:provider:12",
      "compaction-capability-probe:v2:provider:12"
    );
  });
});
