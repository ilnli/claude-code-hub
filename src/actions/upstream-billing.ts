"use server";

import { getSession } from "@/lib/auth";
import { publishProviderCacheInvalidation } from "@/lib/cache/provider-cache";
import { logger } from "@/lib/logger";
import { syncAndTrackProviderUpstreamRate } from "@/lib/upstream-billing/probe-scheduler";
import type { UpstreamRateSyncOutcome } from "@/lib/upstream-billing/sync";
import { findProviderById } from "@/repository";
import type { Provider } from "@/types/provider";
import type { ActionResult } from "./types";

/**
 * 手动「立即同步上游倍率」（套娃场景）。
 *
 * 与定时调度器共用 syncProviderUpstreamRate 核心逻辑：
 * 探测成功回写 cost_multiplier（含加价规则）；上游不支持时立即还原默认倍率，
 * 其他失败在连续第三次起还原默认倍率。
 * 同步结果会记入调度器内存态，避免刚手动同步完就被定时任务重复探测。
 */

const BATCH_SYNC_CONCURRENCY = 4;

export interface UpstreamRateSyncResult {
  providerId: number;
  providerName: string;
  status: UpstreamRateSyncOutcome["status"] | "skipped" | "not_found";
  upstreamRate?: number;
  finalRate?: number;
  error?: string;
}

async function requireAdmin(): Promise<boolean> {
  const session = await getSession();
  return session?.user.role === "admin";
}

async function syncOne(
  provider: Provider
): Promise<{ result: UpstreamRateSyncResult; wrote: boolean }> {
  if (!provider.rateFollowUpstream) {
    return {
      result: { providerId: provider.id, providerName: provider.name, status: "skipped" },
      wrote: false,
    };
  }

  const outcome = await syncAndTrackProviderUpstreamRate(provider);

  return {
    result: {
      providerId: provider.id,
      providerName: provider.name,
      status: outcome.status,
      upstreamRate: outcome.status === "synced" ? outcome.upstreamRate : undefined,
      finalRate:
        outcome.status === "synced" || outcome.status === "unsupported_restored"
          ? outcome.finalRate
          : undefined,
      error: outcome.status === "failed" ? outcome.error || outcome.reason : undefined,
    },
    wrote: outcome.wrote,
  };
}

/**
 * 单个 provider 立即探测/同步上游倍率。
 */
export async function syncProviderUpstreamRateNow(
  providerId: number
): Promise<ActionResult<UpstreamRateSyncResult>> {
  try {
    if (!(await requireAdmin())) {
      return { ok: false, error: "无权限执行此操作" };
    }

    const provider = await findProviderById(providerId);
    if (!provider) {
      return { ok: false, error: "供应商不存在" };
    }
    if (!provider.rateFollowUpstream) {
      return { ok: false, error: "该供应商未开启跟随上游倍率" };
    }

    const execution = await syncOne(provider);
    if (execution.wrote) {
      await publishProviderCacheInvalidation();
    }
    return { ok: true, data: execution.result };
  } catch (error) {
    logger.error("syncProviderUpstreamRateNow failed", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "同步上游倍率失败" };
  }
}

export interface UpstreamRateBatchSyncSummary {
  total: number;
  synced: number;
  unsupported: number;
  failed: number;
  skipped: number;
  results: UpstreamRateSyncResult[];
}

/**
 * 批量立即探测/同步上游倍率（仅处理已开启跟随的 provider，其余记为 skipped）。
 */
export async function syncProvidersUpstreamRateBatch(
  providerIds: number[]
): Promise<ActionResult<UpstreamRateBatchSyncSummary>> {
  try {
    if (!(await requireAdmin())) {
      return { ok: false, error: "无权限执行此操作" };
    }
    if (!Array.isArray(providerIds) || providerIds.length === 0) {
      return { ok: false, error: "请先选择要同步的供应商" };
    }

    const uniqueProviderIds = Array.from(new Set(providerIds));
    const providers = (
      await Promise.all(uniqueProviderIds.map((id) => findProviderById(id).catch(() => null)))
    ).filter((p): p is Provider => p !== null);

    const results: UpstreamRateSyncResult[] = [];
    // 找不到的 id 记为 not_found
    const foundIds = new Set(providers.map((p) => p.id));
    for (const id of uniqueProviderIds) {
      if (!foundIds.has(id)) {
        results.push({ providerId: id, providerName: `#${id}`, status: "not_found" });
      }
    }

    let anyWrite = false;
    let index = 0;
    const worker = async () => {
      while (index < providers.length) {
        const provider = providers[index];
        index += 1;
        if (!provider) {
          continue;
        }
        try {
          const execution = await syncOne(provider);
          anyWrite = anyWrite || execution.wrote;
          results.push(execution.result);
        } catch (error) {
          results.push({
            providerId: provider.id,
            providerName: provider.name,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BATCH_SYNC_CONCURRENCY, providers.length) }, () => worker())
    );

    if (anyWrite) {
      await publishProviderCacheInvalidation();
    }

    const summary: UpstreamRateBatchSyncSummary = {
      total: uniqueProviderIds.length,
      synced: results.filter((r) => r.status === "synced").length,
      unsupported: results.filter(
        (r) => r.status === "unsupported" || r.status === "unsupported_restored"
      ).length,
      failed: results.filter((r) => r.status === "failed" || r.status === "not_found").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      results,
    };
    return { ok: true, data: summary };
  } catch (error) {
    logger.error("syncProvidersUpstreamRateBatch failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "批量同步上游倍率失败" };
  }
}
