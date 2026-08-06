import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanupRuns: vi.fn(),
  execute: vi.fn(),
  getRedisClient: vi.fn(),
  initializeSchedule: vi.fn(),
  listDueRules: vi.fn(),
  postponeRule: vi.fn(),
  recordFault: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  getRedisClient: mocks.getRedisClient,
}));

vi.mock("@/repository/provider-weight-adjustment", () => ({
  cleanupExpiredProviderWeightAdjustmentRuns: mocks.cleanupRuns,
  initializeProviderWeightAdjustmentSchedule: mocks.initializeSchedule,
  listDueProviderWeightAdjustmentRules: mocks.listDueRules,
  postponeDueProviderWeightAdjustmentRule: mocks.postponeRule,
  ProviderWeightAdjustmentError: class extends Error {
    constructor(
      public readonly code: string,
      message: string
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/provider-weight-adjustment/executor", () => ({
  executeProviderWeightAdjustment: mocks.execute,
  recordProviderWeightAdjustmentSchedulerFault: mocks.recordFault,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { ProviderWeightAdjustmentError } from "@/repository/provider-weight-adjustment";
import {
  runProviderWeightAdjustmentSchedulerCycle,
  startProviderWeightAdjustmentScheduler,
  stopProviderWeightAdjustmentScheduler,
} from "@/lib/provider-weight-adjustment/scheduler";

const dueRule = {
  id: 12,
  name: "Scheduled pool",
  description: null,
  providerType: "claude" as const,
  priority: 2,
  isEnabled: true,
  revision: 1,
  nextRunAt: new Date("2026-08-06T00:00:00.000Z"),
  activeRunId: null,
  faultActive: false,
  faultKind: null,
  faultMessage: null,
  faultStartedAt: null,
  lastRunAt: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  deletedAt: null,
};

function redisClient(setResult: "OK" | null = "OK") {
  return {
    status: "ready",
    set: vi.fn().mockResolvedValue(setResult),
    eval: vi.fn().mockResolvedValue(1),
  };
}

describe("provider weight adjustment scheduler cycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const state = globalThis as Record<string, unknown>;
    state.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_STOP_REQUESTED__ = false;
    state.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_STARTED__ = false;
    state.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_INTERVAL__ = undefined;
    state.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_CURRENT__ = undefined;
    mocks.listDueRules.mockResolvedValue([dueRule]);
    mocks.postponeRule.mockResolvedValue(true);
    mocks.recordFault.mockResolvedValue(undefined);
    mocks.execute.mockResolvedValue(undefined);
    mocks.cleanupRuns.mockResolvedValue(0);
    mocks.getRedisClient.mockReturnValue(redisClient());
    mocks.initializeSchedule.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await stopProviderWeightAdjustmentScheduler();
  });

  it("does not touch coordination when no rule is due", async () => {
    mocks.listDueRules.mockResolvedValue([]);

    await runProviderWeightAdjustmentSchedulerCycle();

    expect(mocks.getRedisClient).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed and postpones due rules when Redis is unavailable", async () => {
    mocks.getRedisClient.mockReturnValue(null);

    await runProviderWeightAdjustmentSchedulerCycle();

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.postponeRule).toHaveBeenCalledWith(12, expect.any(Date));
    expect(mocks.recordFault).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 12,
        kind: "coordination_failed",
        message: "Redis coordination is unavailable.",
      })
    );
  });

  it("leaves due time unchanged when another instance owns the lock", async () => {
    mocks.getRedisClient.mockReturnValue(redisClient(null));

    await runProviderWeightAdjustmentSchedulerCycle();

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.postponeRule).not.toHaveBeenCalled();
    expect(mocks.recordFault).not.toHaveBeenCalled();
  });

  it("executes due rules under the Redis lock and cleans expired history", async () => {
    const redis = redisClient();
    mocks.getRedisClient.mockReturnValue(redis);

    await runProviderWeightAdjustmentSchedulerCycle();

    expect(mocks.execute).toHaveBeenCalledWith({ ruleId: 12, trigger: "scheduled" });
    expect(mocks.cleanupRuns).toHaveBeenCalledOnce();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("DEL"),
      1,
      expect.any(String),
      expect.any(String)
    );
  });

  it("postpones and records overlap without queueing another run", async () => {
    mocks.execute.mockRejectedValue(
      new ProviderWeightAdjustmentError("run_overlap", "The rule is already running.")
    );

    await runProviderWeightAdjustmentSchedulerCycle();

    expect(mocks.postponeRule).toHaveBeenCalledWith(12, expect.any(Date));
    expect(mocks.recordFault).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 12, kind: "overlap" })
    );
    expect(mocks.cleanupRuns).toHaveBeenCalledOnce();
  });

  it("records an ordinary scheduler failure separately from overlap", async () => {
    mocks.execute.mockRejectedValue(new Error("unexpected failure"));

    await runProviderWeightAdjustmentSchedulerCycle();

    expect(mocks.recordFault).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 12,
        kind: "scheduler_failed",
        message: "unexpected failure",
      })
    );
  });

  it("does not notify when another cycle already postponed the rule", async () => {
    mocks.getRedisClient.mockReturnValue(null);
    mocks.postponeRule.mockResolvedValue(false);

    await runProviderWeightAdjustmentSchedulerCycle();

    expect(mocks.postponeRule).toHaveBeenCalledOnce();
    expect(mocks.recordFault).not.toHaveBeenCalled();
  });

  it("treats Redis command errors as unavailable coordination", async () => {
    const redis = redisClient();
    redis.set.mockRejectedValue(new Error("connection closed"));
    mocks.getRedisClient.mockReturnValue(redis);

    await runProviderWeightAdjustmentSchedulerCycle();

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.recordFault).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "coordination_failed", message: "connection closed" })
    );
  });

  it("starts only once, initializes restart scheduling, and stops cleanly", async () => {
    startProviderWeightAdjustmentScheduler();
    startProviderWeightAdjustmentScheduler();
    await Promise.resolve();

    expect(mocks.initializeSchedule).toHaveBeenCalledOnce();
    await stopProviderWeightAdjustmentScheduler();
    const state = globalThis as Record<string, unknown>;
    expect(state.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_STARTED__).toBe(false);
    expect(state.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_INTERVAL__).toBeUndefined();
  });

  it("launches a cycle from the fixed scheduler timer", async () => {
    vi.useFakeTimers();
    mocks.listDueRules.mockResolvedValue([]);
    try {
      startProviderWeightAdjustmentScheduler();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(mocks.listDueRules).toHaveBeenCalledOnce();
      await stopProviderWeightAdjustmentScheduler();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops dispatching later rules after lock renewal loses leadership", async () => {
    vi.useFakeTimers();
    let finishFirstRun: (() => void) | undefined;
    const firstRun = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    const redis = redisClient();
    redis.eval.mockResolvedValue(0);
    mocks.getRedisClient.mockReturnValue(redis);
    mocks.listDueRules.mockResolvedValue([{ ...dueRule }, { ...dueRule, id: 13, name: "Second" }]);
    mocks.execute.mockImplementationOnce(() => firstRun);
    try {
      const cycle = runProviderWeightAdjustmentSchedulerCycle();
      await vi.advanceTimersByTimeAsync(30_000);
      finishFirstRun?.();
      await cycle;

      expect(mocks.execute).toHaveBeenCalledTimes(1);
      expect(mocks.postponeRule).toHaveBeenCalledWith(13, expect.any(Date));
      expect(mocks.recordFault).toHaveBeenCalledWith(
        expect.objectContaining({ ruleId: 13, kind: "coordination_failed" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns immediately when shutdown was requested", async () => {
    const state = globalThis as Record<string, unknown>;
    state.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_STOP_REQUESTED__ = true;

    await runProviderWeightAdjustmentSchedulerCycle();

    expect(mocks.listDueRules).not.toHaveBeenCalled();
  });
});
