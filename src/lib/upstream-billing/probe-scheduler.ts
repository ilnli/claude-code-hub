import { publishProviderCacheInvalidation } from "@/lib/cache/provider-cache";
import { logger } from "@/lib/logger";
import { sendUpstreamBillingProbeFailureAlert } from "@/lib/notification/notifier";
import {
  acquireLeaderLock,
  type LeaderLock,
  releaseLeaderLock,
  renewLeaderLock,
  startLeaderLockKeepAlive,
} from "@/lib/provider-endpoints/leader-lock";
import { getUpstreamBillingProbeSettings } from "@/lib/system-settings/upstream-billing-probe";
import {
  syncProviderUpstreamRate,
  type UpstreamRateSyncOutcome,
} from "@/lib/upstream-billing/sync";
import { findFollowUpstreamProviders } from "@/repository";
import type { Provider } from "@/types/provider";

/**
 * 上游倍率探测调度器（套娃场景）。
 *
 * 每 tick（60s）：
 * 1. 读取 system_settings 的运行时设置——全局关闭则空转（默认关闭，零影响）；
 * 2. 持 Redis leader lock（多实例安全），扫描所有开启「跟随上游倍率」的 provider；
 * 3. 将所有到期的 provider 加入 FIFO 队列后按各自协议执行探测（sub2api 走
 *    GET {上游}/sub2api/billing；newapi 走 /api/pricing 倍率表 + /api/log/token 校准）：
 *    队列按 provider ID 去重，从入队到处理完成都不会重复入队；并发受限，
 *    但不设单轮数量上限，避免固定顺序切片导致靠后的 provider 饿死；
 * 4. 成功后回写 cost_multiplier = applyMarkup(resolved_rate_multiplier)，
 *    并记录上游倍率快照与同步时间；
 * 5. 常规失败时，前两次保留上次成功倍率，第三次起回退默认倍率；
 *    每次失败均通知，并按 ×2（封顶 ×8）退避。HTTP 404 则立即用默认倍率兜底，
 *    并固定为 8 倍间隔降频；
 * 6. provider_changed（管理员并发改动导致 CAS 写入跳过）不算上游故障：
 *    只刷新本轮尝试时间，不计入连续失败、不发失败通知。
 *
 * 到期判定优先读进程内内存态；没有内存态时（进程重启、或 leader 轮换到未探测过的实例）
 * 回落到库里的 upstream_rate_synced_at，因此成功节奏可跨实例存活，
 * 不会在每次 leader 切换时把所有 provider 重新探测一遍。
 * 已知取舍：连续失败计数与退避倍数仍只存在于进程内存，不持久化——
 * 进程重启或 leader 切换后从零重新计数。
 */

const LOCK_KEY = "locks:upstream-billing-probe-scheduler";
const TICK_INTERVAL_MS = 60_000;
const LOCK_TTL_MS = 30_000;
const CONCURRENCY = 4;
const MAX_BACKOFF_MULTIPLIER = 8;
// newapi 协议每轮都要请求 /api/log/token（CriticalRateLimit 默认 20 次/20 分钟/源 IP
// 共享桶），有效探测间隔设下限，避免同站点多 key 时打满上游限流
const NEWAPI_MIN_INTERVAL_MS = 5 * 60_000;

function getEffectiveIntervalMs(provider: Provider, intervalMs: number): number {
  return provider.rateUpstreamType === "newapi"
    ? Math.max(intervalMs, NEWAPI_MIN_INTERVAL_MS)
    : intervalMs;
}

interface ProbeMemoryEntry {
  lastAttemptAtMs: number;
  failures: number;
  unsupported: boolean;
}

const schedulerState = globalThis as unknown as {
  __CCH_UPSTREAM_BILLING_PROBE_STARTED__?: boolean;
  __CCH_UPSTREAM_BILLING_PROBE_INTERVAL_ID__?: ReturnType<typeof setInterval>;
  __CCH_UPSTREAM_BILLING_PROBE_RUNNING__?: boolean;
  __CCH_UPSTREAM_BILLING_PROBE_LOCK__?: LeaderLock;
  __CCH_UPSTREAM_BILLING_PROBE_STOP_REQUESTED__?: boolean;
  __CCH_UPSTREAM_BILLING_PROBE_CURRENT_PROMISE__?: Promise<void>;
  __CCH_UPSTREAM_BILLING_PROBE_MEMORY__?: Map<number, ProbeMemoryEntry>;
  __CCH_UPSTREAM_BILLING_PROBE_QUEUE__?: Provider[];
  __CCH_UPSTREAM_BILLING_PROBE_QUEUED_IDS__?: Set<number>;
};

function getMemory(): Map<number, ProbeMemoryEntry> {
  if (!schedulerState.__CCH_UPSTREAM_BILLING_PROBE_MEMORY__) {
    schedulerState.__CCH_UPSTREAM_BILLING_PROBE_MEMORY__ = new Map();
  }
  return schedulerState.__CCH_UPSTREAM_BILLING_PROBE_MEMORY__;
}

function getProbeQueue(): Provider[] {
  if (!schedulerState.__CCH_UPSTREAM_BILLING_PROBE_QUEUE__) {
    schedulerState.__CCH_UPSTREAM_BILLING_PROBE_QUEUE__ = [];
  }
  return schedulerState.__CCH_UPSTREAM_BILLING_PROBE_QUEUE__;
}

function getQueuedProviderIds(): Set<number> {
  if (!schedulerState.__CCH_UPSTREAM_BILLING_PROBE_QUEUED_IDS__) {
    schedulerState.__CCH_UPSTREAM_BILLING_PROBE_QUEUED_IDS__ = new Set();
  }
  return schedulerState.__CCH_UPSTREAM_BILLING_PROBE_QUEUED_IDS__;
}

function enqueueProviders(providers: Provider[]): number {
  const queue = getProbeQueue();
  const queuedIds = getQueuedProviderIds();
  let added = 0;

  for (const provider of providers) {
    if (queuedIds.has(provider.id)) {
      continue;
    }
    queue.push(provider);
    queuedIds.add(provider.id);
    added += 1;
  }

  return added;
}

function clearProbeQueue(): void {
  getProbeQueue().length = 0;
  getQueuedProviderIds().clear();
}

function getBackoffMultiplier(entry: ProbeMemoryEntry | undefined): number {
  if (!entry) {
    return 1;
  }
  if (entry.unsupported) {
    return MAX_BACKOFF_MULTIPLIER;
  }
  return Math.min(2 ** entry.failures, MAX_BACKOFF_MULTIPLIER);
}

function filterDueProviders(providers: Provider[], intervalMs: number, nowMs: number): Provider[] {
  const memory = getMemory();
  return providers.filter((provider) => {
    const effectiveIntervalMs = getEffectiveIntervalMs(provider, intervalMs);
    const entry = memory.get(provider.id);
    if (entry) {
      // 内存态优先：同时编码了失败计数与退避倍数
      const dueAtMs = entry.lastAttemptAtMs + effectiveIntervalMs * getBackoffMultiplier(entry);
      return nowMs >= dueAtMs;
    }

    // 本进程无内存态（重启或 leader 切换）：回落到库里的上次成功同步时间
    const syncedAtMs = provider.upstreamRateSyncedAt?.getTime();
    if (syncedAtMs == null || !Number.isFinite(syncedAtMs)) {
      // 确实从未成功同步过：立即到期
      return true;
    }
    return nowMs >= syncedAtMs + effectiveIntervalMs;
  });
}

async function ensureLeaderLock(): Promise<boolean> {
  const current = schedulerState.__CCH_UPSTREAM_BILLING_PROBE_LOCK__;
  if (current) {
    const ok = await renewLeaderLock(current, LOCK_TTL_MS);
    if (ok) {
      return true;
    }

    schedulerState.__CCH_UPSTREAM_BILLING_PROBE_LOCK__ = undefined;
    await releaseLeaderLock(current);
  }

  const acquired = await acquireLeaderLock(LOCK_KEY, LOCK_TTL_MS);
  if (!acquired) {
    return false;
  }

  schedulerState.__CCH_UPSTREAM_BILLING_PROBE_LOCK__ = acquired;
  return true;
}

function recordAttempt(providerId: number, entry: ProbeMemoryEntry): void {
  getMemory().set(providerId, entry);
}

/**
 * 管理员并发改动 provider 导致 CAS 写入被跳过：上游本身没出问题，
 * 不计入连续失败、不告警，下一轮按常规间隔重试即可。
 */
function isConcurrentProviderChange(outcome: UpstreamRateSyncOutcome): boolean {
  return outcome.status === "failed" && outcome.reason === "provider_changed";
}

/**
 * 记录一次同步结果到调度器内存态（定时探测与手动「立即同步」共用）。
 * 手动同步后按全间隔重新计时，避免紧接着被定时任务重复探测。
 */
export function noteUpstreamRateSyncOutcome(
  providerId: number,
  outcome: UpstreamRateSyncOutcome
): number {
  const previous = getMemory().get(providerId);
  const nowMs = Date.now();
  let entry: ProbeMemoryEntry;

  switch (outcome.status) {
    case "synced":
      entry = { lastAttemptAtMs: nowMs, failures: 0, unsupported: false };
      break;
    case "unsupported_restored":
    case "unsupported":
      entry = {
        lastAttemptAtMs: nowMs,
        failures: (previous?.failures ?? 0) + 1,
        unsupported: true,
      };
      break;
    default:
      if (isConcurrentProviderChange(outcome)) {
        // 只刷新尝试时间，保留既有失败计数与 unsupported 标记
        entry = {
          lastAttemptAtMs: nowMs,
          failures: previous?.failures ?? 0,
          unsupported: previous?.unsupported ?? false,
        };
        break;
      }
      entry = {
        lastAttemptAtMs: nowMs,
        failures: (previous?.failures ?? 0) + 1,
        // group_not_in_table 属配置问题（分组不在上游匿名倍率表），持续重试无意义，
        // 与 unsupported 同按 8x 退避，等待管理员介入
        unsupported: outcome.status === "failed" && outcome.reason === "group_not_in_table",
      };
      break;
  }

  recordAttempt(providerId, entry);
  return entry.failures;
}

function describeSyncFailure(outcome: UpstreamRateSyncOutcome): string {
  if (outcome.status === "unsupported" || outcome.status === "unsupported_restored") {
    return "upstream billing probe is unsupported";
  }
  if (outcome.status === "failed") {
    const httpStatus = outcome.httpStatus == null ? "" : ` (HTTP ${outcome.httpStatus})`;
    const fallbackError = outcome.fallbackError ? `; fallback: ${outcome.fallbackError}` : "";
    return `${outcome.error || outcome.reason}${httpStatus}${fallbackError}`;
  }
  return "unknown upstream billing probe failure";
}

/**
 * 执行一次探测，并统一维护连续失败计数、默认倍率回退与失败通知。
 * 定时调度和手动同步必须共用此入口，避免两条路径语义漂移。
 */
export async function syncAndTrackProviderUpstreamRate(
  provider: Provider
): Promise<UpstreamRateSyncOutcome> {
  const nextFailureCount = (getMemory().get(provider.id)?.failures ?? 0) + 1;
  let outcome: UpstreamRateSyncOutcome;

  try {
    outcome = await syncProviderUpstreamRate(provider, {
      consecutiveFailureCount: nextFailureCount,
    });
  } catch (error) {
    outcome = {
      status: "failed",
      reason: "internal",
      error: error instanceof Error ? error.message : String(error),
      wrote: false,
    };
  }

  const failureCount = noteUpstreamRateSyncOutcome(provider.id, outcome);
  if (outcome.status !== "synced" && !isConcurrentProviderChange(outcome)) {
    const fallbackApplied =
      outcome.status === "unsupported_restored" ||
      (outcome.status === "failed" && outcome.fallbackApplied === true);
    const fallbackRate =
      outcome.status === "unsupported_restored"
        ? outcome.finalRate
        : outcome.status === "failed"
          ? outcome.fallbackRate
          : undefined;

    await sendUpstreamBillingProbeFailureAlert({
      providerId: provider.id,
      providerName: provider.name,
      failureCount,
      lastError: describeSyncFailure(outcome),
      fallbackApplied,
      fallbackRate,
    });
  }

  return outcome;
}

async function probeOneProvider(provider: Provider): Promise<boolean> {
  const outcome = await syncAndTrackProviderUpstreamRate(provider);

  switch (outcome.status) {
    case "synced":
      logger.info("[UpstreamBillingProbe] synced upstream rate", {
        providerId: provider.id,
        upstreamRate: outcome.upstreamRate,
        finalRate: outcome.finalRate,
        markupType: provider.rateMarkupType,
        markupValue: provider.rateMarkupValue,
      });
      break;
    case "unsupported_restored":
      logger.info("[UpstreamBillingProbe] upstream unsupported, restored default rate", {
        providerId: provider.id,
        fallbackRate: outcome.finalRate,
      });
      break;
    default:
      logger.warn("[UpstreamBillingProbe] probe failed", {
        providerId: provider.id,
        status: outcome.status,
      });
      break;
  }

  return outcome.wrote;
}

async function runProbeCycle(): Promise<void> {
  if (schedulerState.__CCH_UPSTREAM_BILLING_PROBE_RUNNING__) {
    return;
  }

  if (schedulerState.__CCH_UPSTREAM_BILLING_PROBE_STOP_REQUESTED__) {
    return;
  }

  schedulerState.__CCH_UPSTREAM_BILLING_PROBE_RUNNING__ = true;

  let leadershipLost = false;
  let stopKeepAlive: (() => void) | undefined;

  try {
    // 全局开关（system_settings）：默认关闭，关闭时空转
    const settings = await getUpstreamBillingProbeSettings();
    if (!settings.enabled) {
      return;
    }

    const isLeader = await ensureLeaderLock();
    if (!isLeader) {
      return;
    }

    stopKeepAlive = startLeaderLockKeepAlive({
      getLock: () => schedulerState.__CCH_UPSTREAM_BILLING_PROBE_LOCK__,
      clearLock: () => {
        schedulerState.__CCH_UPSTREAM_BILLING_PROBE_LOCK__ = undefined;
      },
      ttlMs: LOCK_TTL_MS,
      logTag: "UpstreamBillingProbe",
      onLost: () => {
        leadershipLost = true;
      },
    }).stop;

    const intervalMs = Math.max(1, settings.intervalMinutes) * 60_000;
    const allProviders = await findFollowUpstreamProviders();
    if (allProviders.length === 0) {
      return;
    }

    const nowMs = Date.now();
    // 不设数量上限：到期的一个不剩全部探测，避免固定顺序切片饿死靠后的 provider
    const dueProviders = filterDueProviders(allProviders, intervalMs, nowMs);
    if (dueProviders.length === 0) {
      return;
    }

    enqueueProviders(dueProviders);
    const concurrency = Math.max(1, Math.min(CONCURRENCY, getProbeQueue().length));
    let anyWrite = false;

    const worker = async () => {
      while (!leadershipLost && !schedulerState.__CCH_UPSTREAM_BILLING_PROBE_STOP_REQUESTED__) {
        const provider = getProbeQueue().shift();
        if (!provider) {
          return;
        }

        try {
          const wrote = await probeOneProvider(provider);
          anyWrite = anyWrite || wrote;
        } catch (error) {
          recordAttempt(provider.id, {
            lastAttemptAtMs: Date.now(),
            failures: (getMemory().get(provider.id)?.failures ?? 0) + 1,
            unsupported: false,
          });
          logger.warn("[UpstreamBillingProbe] probe error", {
            providerId: provider.id,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          getQueuedProviderIds().delete(provider.id);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    // 有写回时广播 provider 缓存失效（30s TTL 兜底之外的即时生效）
    if (anyWrite) {
      await publishProviderCacheInvalidation();
    }
  } catch (error) {
    logger.warn("[UpstreamBillingProbe] probe cycle error", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    stopKeepAlive?.();
    clearProbeQueue();
    schedulerState.__CCH_UPSTREAM_BILLING_PROBE_RUNNING__ = false;
  }
}

function launchProbeCycle(): void {
  if (schedulerState.__CCH_UPSTREAM_BILLING_PROBE_CURRENT_PROMISE__) return;
  const current = runProbeCycle().finally(() => {
    if (schedulerState.__CCH_UPSTREAM_BILLING_PROBE_CURRENT_PROMISE__ === current) {
      schedulerState.__CCH_UPSTREAM_BILLING_PROBE_CURRENT_PROMISE__ = undefined;
    }
  });
  schedulerState.__CCH_UPSTREAM_BILLING_PROBE_CURRENT_PROMISE__ = current;
}

export function startUpstreamBillingProbeScheduler(): void {
  if (schedulerState.__CCH_UPSTREAM_BILLING_PROBE_STARTED__) {
    return;
  }

  schedulerState.__CCH_UPSTREAM_BILLING_PROBE_STOP_REQUESTED__ = false;
  schedulerState.__CCH_UPSTREAM_BILLING_PROBE_STARTED__ = true;

  launchProbeCycle();

  schedulerState.__CCH_UPSTREAM_BILLING_PROBE_INTERVAL_ID__ = setInterval(() => {
    launchProbeCycle();
  }, TICK_INTERVAL_MS);

  logger.info("[UpstreamBillingProbe] Started", {
    tickIntervalMs: TICK_INTERVAL_MS,
    concurrency: CONCURRENCY,
    lockTtlMs: LOCK_TTL_MS,
  });
}

export async function stopUpstreamBillingProbeScheduler(): Promise<void> {
  schedulerState.__CCH_UPSTREAM_BILLING_PROBE_STOP_REQUESTED__ = true;

  const intervalId = schedulerState.__CCH_UPSTREAM_BILLING_PROBE_INTERVAL_ID__;
  if (intervalId) {
    clearInterval(intervalId);
  }

  schedulerState.__CCH_UPSTREAM_BILLING_PROBE_INTERVAL_ID__ = undefined;
  schedulerState.__CCH_UPSTREAM_BILLING_PROBE_STARTED__ = false;

  await schedulerState.__CCH_UPSTREAM_BILLING_PROBE_CURRENT_PROMISE__;
  clearProbeQueue();

  const lock = schedulerState.__CCH_UPSTREAM_BILLING_PROBE_LOCK__;
  schedulerState.__CCH_UPSTREAM_BILLING_PROBE_LOCK__ = undefined;
  if (lock) {
    await releaseLeaderLock(lock);
  }
}

export function getUpstreamBillingProbeSchedulerStatus(): {
  started: boolean;
  running: boolean;
  tickIntervalMs: number;
  trackedProviders: number;
  queuedProviders: number;
} {
  return {
    started: schedulerState.__CCH_UPSTREAM_BILLING_PROBE_STARTED__ === true,
    running: schedulerState.__CCH_UPSTREAM_BILLING_PROBE_RUNNING__ === true,
    tickIntervalMs: TICK_INTERVAL_MS,
    trackedProviders: getMemory().size,
    queuedProviders: getQueuedProviderIds().size,
  };
}
