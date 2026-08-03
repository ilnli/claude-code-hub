import { probeUpstreamBilling } from "@/lib/upstream-billing/client";
import { applyMarkup } from "@/lib/upstream-billing/rate-resolver";
import { restoreProviderCostMultiplier, updateUpstreamBillingProbeResult } from "@/repository";
import type { Provider } from "@/types/provider";

/**
 * 上游倍率同步核心逻辑（调度器与手动「立即同步」共用）。
 *
 * - 探测成功：回写 cost_multiplier = applyMarkup(resolved_rate_multiplier)，并记录快照；
 * - 上游不支持（HTTP 400/404）：若当前值与默认倍率（加价后）不一致则还原，否则不动；
 * - 其他失败：若曾成功同步，前两次沿用旧值，第三次起回退默认倍率。
 */

// cost_multiplier 浮点比较容差（避免无效写库与缓存失效广播）
const COST_MULTIPLIER_EPSILON = 1e-9;

export type UpstreamRateSyncOutcome =
  | { status: "synced"; upstreamRate: number; finalRate: number; wrote: boolean }
  | { status: "unsupported_restored"; finalRate: number; wrote: boolean }
  | { status: "unsupported"; wrote: boolean }
  | {
      status: "failed";
      reason: string;
      error?: string;
      httpStatus?: number;
      wrote: boolean;
      fallbackApplied?: boolean;
      fallbackRate?: number;
      fallbackError?: "provider_changed";
    };

export interface UpstreamRateSyncOptions {
  /** Consecutive failure count including the current attempt. */
  consecutiveFailureCount?: number;
}

export async function syncProviderUpstreamRate(
  provider: Provider,
  options: UpstreamRateSyncOptions = {}
): Promise<UpstreamRateSyncOutcome> {
  let result: Awaited<ReturnType<typeof probeUpstreamBilling>>;
  try {
    result = await probeUpstreamBilling(provider);
  } catch (error) {
    result = {
      ok: false,
      reason: "network",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.ok) {
    const finalRate = applyMarkup(result.rate, provider.rateMarkupType, provider.rateMarkupValue);
    const wrote = await updateUpstreamBillingProbeResult(
      provider.id,
      {
        costMultiplier: finalRate,
        upstreamRateMultiplier: result.rate,
        syncedAt: new Date(),
      },
      provider.updatedAt
    );
    if (!wrote) {
      return { status: "failed", reason: "provider_changed", wrote: false };
    }
    return { status: "synced", upstreamRate: result.rate, finalRate, wrote: true };
  }

  if (result.reason === "unsupported") {
    if (provider.rateDefaultMultiplier != null) {
      const fallbackRate = applyMarkup(
        provider.rateDefaultMultiplier,
        provider.rateMarkupType,
        provider.rateMarkupValue
      );
      if (Math.abs(provider.costMultiplier - fallbackRate) > COST_MULTIPLIER_EPSILON) {
        const wrote = await restoreProviderCostMultiplier(
          provider.id,
          fallbackRate,
          provider.updatedAt
        );
        if (!wrote) {
          return { status: "failed", reason: "provider_changed", wrote: false };
        }
        return { status: "unsupported_restored", finalRate: fallbackRate, wrote: true };
      }
    }
    return { status: "unsupported", wrote: false };
  }

  const failure = {
    status: "failed",
    reason: result.reason,
    error: result.error,
    httpStatus: result.status,
    wrote: false,
  } as const;

  const shouldRestoreDefault =
    (options.consecutiveFailureCount ?? 0) >= 3 &&
    provider.upstreamRateMultiplier != null &&
    provider.rateDefaultMultiplier != null;

  if (!shouldRestoreDefault || provider.rateDefaultMultiplier == null) {
    return failure;
  }

  const fallbackRate = applyMarkup(
    provider.rateDefaultMultiplier,
    provider.rateMarkupType,
    provider.rateMarkupValue
  );
  if (Math.abs(provider.costMultiplier - fallbackRate) <= COST_MULTIPLIER_EPSILON) {
    return {
      ...failure,
      fallbackApplied: true,
      fallbackRate,
    };
  }

  const wrote = await restoreProviderCostMultiplier(provider.id, fallbackRate, provider.updatedAt);
  return {
    ...failure,
    wrote,
    fallbackApplied: wrote,
    fallbackRate,
    ...(wrote ? {} : { fallbackError: "provider_changed" as const }),
  };
}
