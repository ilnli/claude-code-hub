import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";
import {
  cleanupExpiredProviderWeightAdjustmentRuns,
  initializeProviderWeightAdjustmentSchedule,
  listDueProviderWeightAdjustmentRules,
  ProviderWeightAdjustmentError,
  postponeDueProviderWeightAdjustmentRule,
} from "@/repository/provider-weight-adjustment";
import {
  executeProviderWeightAdjustment,
  recordProviderWeightAdjustmentSchedulerFault,
} from "./executor";

const TICK_INTERVAL_MS = 30_000;
const LOCK_TTL_MS = 60_000;
const LOCK_KEY = "cch:provider-weight-adjustment:scheduler";

const schedulerState = globalThis as typeof globalThis & {
  __CCH_PROVIDER_WEIGHT_ADJUSTMENT_STARTED__?: boolean;
  __CCH_PROVIDER_WEIGHT_ADJUSTMENT_STOP_REQUESTED__?: boolean;
  __CCH_PROVIDER_WEIGHT_ADJUSTMENT_INTERVAL__?: ReturnType<typeof setInterval>;
  __CCH_PROVIDER_WEIGHT_ADJUSTMENT_CURRENT__?: Promise<void>;
};

type StrictLockResult =
  | { status: "acquired"; lockId: string }
  | { status: "contended" }
  | { status: "unavailable"; message: string };

async function acquireStrictLock(): Promise<StrictLockResult> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") {
    return { status: "unavailable", message: "Redis coordination is unavailable." };
  }
  const lockId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const result = await redis.set(LOCK_KEY, lockId, "PX", LOCK_TTL_MS, "NX");
    return result === "OK" ? { status: "acquired", lockId } : { status: "contended" };
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function renewStrictLock(lockId: string): Promise<boolean> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") return false;
  try {
    const result = await redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
      1,
      LOCK_KEY,
      lockId,
      String(LOCK_TTL_MS)
    );
    return result === 1;
  } catch {
    return false;
  }
}

async function releaseStrictLock(lockId: string): Promise<void> {
  const redis = getRedisClient({ allowWhenRateLimitDisabled: true });
  if (redis?.status !== "ready") return;
  try {
    await redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      LOCK_KEY,
      lockId
    );
  } catch (error) {
    logger.warn("[ProviderWeightAdjustment] failed to release scheduler lock", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function postponeAndRecordFault(input: {
  ruleId: number;
  ruleName: string;
  kind: "coordination_failed" | "scheduler_failed" | "overlap";
  message: string;
  now: Date;
}): Promise<void> {
  const postponed = await postponeDueProviderWeightAdjustmentRule(input.ruleId, input.now);
  if (!postponed) return;
  await recordProviderWeightAdjustmentSchedulerFault(input);
}

export async function runProviderWeightAdjustmentSchedulerCycle(): Promise<void> {
  if (schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_STOP_REQUESTED__) return;
  const now = new Date();
  const dueRules = await listDueProviderWeightAdjustmentRules(now);
  if (dueRules.length === 0) return;

  const lock = await acquireStrictLock();
  if (lock.status === "contended") return;
  if (lock.status === "unavailable") {
    await Promise.all(
      dueRules.map((rule) =>
        postponeAndRecordFault({
          ruleId: rule.id,
          ruleName: rule.name,
          kind: "coordination_failed",
          message: lock.message,
          now,
        })
      )
    );
    return;
  }

  let leadershipLost = false;
  const keepAlive = setInterval(
    () => {
      void renewStrictLock(lock.lockId).then((renewed) => {
        if (!renewed) leadershipLost = true;
      });
    },
    Math.floor(LOCK_TTL_MS / 2)
  );
  (keepAlive as unknown as { unref?: () => void }).unref?.();

  try {
    for (const rule of dueRules) {
      if (schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_STOP_REQUESTED__) break;
      if (leadershipLost) {
        await postponeAndRecordFault({
          ruleId: rule.id,
          ruleName: rule.name,
          kind: "coordination_failed",
          message: "The distributed scheduler lock was lost.",
          now: new Date(),
        });
        continue;
      }
      try {
        await executeProviderWeightAdjustment({ ruleId: rule.id, trigger: "scheduled" });
      } catch (error) {
        const overlap =
          error instanceof ProviderWeightAdjustmentError && error.code === "run_overlap";
        await postponeAndRecordFault({
          ruleId: rule.id,
          ruleName: rule.name,
          kind: overlap ? "overlap" : "scheduler_failed",
          message: error instanceof Error ? error.message : String(error),
          now: new Date(),
        });
      }
    }
    await cleanupExpiredProviderWeightAdjustmentRuns();
  } finally {
    clearInterval(keepAlive);
    await releaseStrictLock(lock.lockId);
  }
}

function launchCycle(): void {
  if (schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_CURRENT__) return;
  const current = runProviderWeightAdjustmentSchedulerCycle()
    .catch((error) => {
      logger.warn("[ProviderWeightAdjustment] scheduler cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      if (schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_CURRENT__ === current) {
        schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_CURRENT__ = undefined;
      }
    });
  schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_CURRENT__ = current;
}

export function startProviderWeightAdjustmentScheduler(): void {
  if (schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_STARTED__) return;
  schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_STARTED__ = true;
  schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_STOP_REQUESTED__ = false;
  schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_CURRENT__ =
    initializeProviderWeightAdjustmentSchedule()
      .catch((error) => {
        logger.warn("[ProviderWeightAdjustment] schedule initialization failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_CURRENT__ = undefined;
      });
  schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_INTERVAL__ = setInterval(
    launchCycle,
    TICK_INTERVAL_MS
  );
  logger.info("[ProviderWeightAdjustment] scheduler started", {
    tickIntervalMs: TICK_INTERVAL_MS,
  });
}

export async function stopProviderWeightAdjustmentScheduler(): Promise<void> {
  schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_STOP_REQUESTED__ = true;
  const interval = schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_INTERVAL__;
  if (interval) clearInterval(interval);
  schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_INTERVAL__ = undefined;
  schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_STARTED__ = false;
  await schedulerState.__CCH_PROVIDER_WEIGHT_ADJUSTMENT_CURRENT__;
}
