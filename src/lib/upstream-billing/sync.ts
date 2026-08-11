import { logger } from "@/lib/logger";
import { probeUpstreamBilling } from "@/lib/upstream-billing/client";
import { fetchNewapiTokenGroup } from "@/lib/upstream-billing/newapi-client";
import { resolveNewapiProbeRequestContext } from "@/lib/upstream-billing/newapi-probe-context";
import { getNewapiRatioTable } from "@/lib/upstream-billing/newapi-table-cache";
import { applyMarkup, isValidUpstreamRate } from "@/lib/upstream-billing/rate-resolver";
import { restoreProviderCostMultiplier, updateUpstreamBillingProbeResult } from "@/repository";
import type { Provider } from "@/types/provider";

/**
 * 上游倍率同步核心逻辑（调度器与手动「立即同步」共用）。
 *
 * 按 provider.rateUpstreamType 分发两种探测协议：
 * - sub2api：GET {版本根}/sub2api/billing，消费 resolved_rate_multiplier；
 * - newapi：匿名 GET {站点}/api/pricing 取 group_ratio 倍率表，配合
 *   GET {站点}/api/log/token 校准 key 实际落组分组后取对应分组倍率。
 *
 * 共同的回写/回退语义：
 * - 探测成功：回写 cost_multiplier = applyMarkup(upstream_rate)，并记录快照；
 * - 上游不支持（sub2api HTTP 404；newapi pricing 403/404）：立即还原默认倍率；
 * - 其他失败：若曾成功同步，前两次沿用旧值，第三次起回退默认倍率；
 * - newapi 特有：分组无法确定（group_unknown）按普通失败处理；
 *   分组不在匿名倍率表（group_not_in_table）属配置问题，立即还原默认倍率并按 8x 退避。
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
      fallbackCause?: "failure_threshold";
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
  if (provider.rateUpstreamType === "newapi") {
    return syncProviderUpstreamRateNewApi(provider, options);
  }
  return syncProviderUpstreamRateSub2api(provider, options);
}

async function syncProviderUpstreamRateSub2api(
  provider: Provider,
  options: UpstreamRateSyncOptions
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

  return buildFailureOutcome(provider, options, {
    reason: result.reason,
    error: result.error,
    httpStatus: result.status,
  });
}

/**
 * 失败 outcome 构造：若已连续失败 >=3 次且曾成功同步过，则回退默认倍率。
 * sub2api 与 newapi 两条路径共用，保证失败语义一致。
 */
async function buildFailureOutcome(
  provider: Provider,
  options: UpstreamRateSyncOptions,
  failure: { reason: string; error?: string; httpStatus?: number }
): Promise<UpstreamRateSyncOutcome> {
  const base = {
    status: "failed",
    reason: failure.reason,
    error: failure.error,
    httpStatus: failure.httpStatus,
    wrote: false,
  } as const;

  const shouldRestoreDefault =
    (options.consecutiveFailureCount ?? 0) >= 3 &&
    provider.upstreamRateMultiplier != null &&
    provider.rateDefaultMultiplier != null;

  if (!shouldRestoreDefault || provider.rateDefaultMultiplier == null) {
    return base;
  }

  const fallbackRate = applyMarkup(
    provider.rateDefaultMultiplier,
    provider.rateMarkupType,
    provider.rateMarkupValue
  );
  if (Math.abs(provider.costMultiplier - fallbackRate) <= COST_MULTIPLIER_EPSILON) {
    return {
      ...base,
      fallbackApplied: true,
      fallbackRate,
      fallbackCause: "failure_threshold",
    };
  }

  const wrote = await restoreProviderCostMultiplier(provider.id, fallbackRate, provider.updatedAt);
  return {
    ...base,
    wrote,
    fallbackApplied: wrote,
    fallbackRate,
    fallbackCause: "failure_threshold",
    ...(wrote ? {} : { fallbackError: "provider_changed" as const }),
  };
}

/**
 * new-api 协议同步：
 * 1. 用 sk- 拉 /api/log/token 求众数分组做校准——校准失败/无日志不阻塞，
 *    回落到用户配置的 newapiGroup；
 * 2. 站点 PAT 价格表优先，匿名价格表次之；PAT 错误不阻塞匿名回退；
 * 3. 分组仍为空 -> group_unknown（普通失败，3 次宽限后回退默认倍率）；
 * 4. 分组不在可用价格表或倍率越界 -> group_not_in_table（配置问题，
 *    立即还原默认倍率，调度器按 8x 退避）。
 */
async function syncProviderUpstreamRateNewApi(
  provider: Provider,
  options: UpstreamRateSyncOptions
): Promise<UpstreamRateSyncOutcome> {
  let context: Awaited<ReturnType<typeof resolveNewapiProbeRequestContext>>;
  try {
    context = await resolveNewapiProbeRequestContext(provider);
  } catch (error) {
    return buildFailureOutcome(provider, options, {
      reason: "network",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!context) {
    return buildFailureOutcome(provider, options, {
      reason: "invalid",
      error: "provider url is not a valid URL",
    });
  }

  // 日志校准必须继续使用 Provider 自己的 sk，即使价格表已经由站点 PAT 认证。
  let observedGroup: string | null = null;
  try {
    const groupResult = await fetchNewapiTokenGroup(provider, context);
    if (groupResult.ok) {
      observedGroup = groupResult.group;
    } else {
      logger.warn("[UpstreamBilling] newapi group calibration failed, using configured group", {
        providerId: provider.id,
        reason: groupResult.reason,
        error: groupResult.error,
      });
    }
  } catch (error) {
    logger.warn("[UpstreamBilling] newapi group calibration error, using configured group", {
      providerId: provider.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const configuredGroup = provider.newapiGroup?.trim() || null;
  const effectiveGroup = observedGroup ?? configuredGroup;

  if (!effectiveGroup) {
    return buildFailureOutcome(provider, options, {
      reason: "group_unknown",
      error: "billing group unknown: no consume logs for this key and no upstream group configured",
    });
  }

  let patTable: Awaited<ReturnType<typeof getNewapiRatioTable>> | null = null;
  if (context.dashboardPat && context.dashboardUserId != null) {
    try {
      patTable = await getNewapiRatioTable(provider, {
        context,
        authenticated: true,
      });
    } catch (error) {
      logger.warn("[UpstreamBilling] newapi PAT pricing probe failed, using anonymous pricing", {
        providerId: provider.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let rate: number | null = null;
  let pricingSource: "pat" | "anonymous" | null = null;
  if (patTable?.ok) {
    const patRate = patTable.table[effectiveGroup];
    if (patRate != null && isValidUpstreamRate(patRate)) {
      rate = patRate;
      pricingSource = "pat";
    }
  }

  let anonymousTable: Awaited<ReturnType<typeof getNewapiRatioTable>> | null = null;
  if (rate == null) {
    try {
      anonymousTable = await getNewapiRatioTable(provider, { context });
    } catch (error) {
      anonymousTable = {
        ok: false,
        reason: "network",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (anonymousTable.ok) {
      const anonymousRate = anonymousTable.table[effectiveGroup];
      if (anonymousRate != null && isValidUpstreamRate(anonymousRate)) {
        rate = anonymousRate;
        pricingSource = "anonymous";
      }
    }
  }

  if (rate == null) {
    if (anonymousTable && !anonymousTable.ok && !patTable?.ok) {
      if (anonymousTable.reason === "unsupported") {
        // pricing 模块关闭/非 new-api 站点：与 sub2api unsupported 同语义，立即还原默认倍率
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
      return buildFailureOutcome(provider, options, {
        reason: anonymousTable.reason,
        error: anonymousTable.error,
        httpStatus: anonymousTable.status,
      });
    }

    // A valid table that does not expose this group is a configuration/group visibility issue.
    const error = `group "${effectiveGroup}" is not in the available upstream ratio tables (or its ratio is out of range); check the group config or the default rate`;
    if (provider.rateDefaultMultiplier != null) {
      const fallbackRate = applyMarkup(
        provider.rateDefaultMultiplier,
        provider.rateMarkupType,
        provider.rateMarkupValue
      );
      if (Math.abs(provider.costMultiplier - fallbackRate) <= COST_MULTIPLIER_EPSILON) {
        return {
          status: "failed",
          reason: "group_not_in_table",
          error,
          wrote: false,
          fallbackApplied: true,
          fallbackRate,
        };
      }
      const wrote = await restoreProviderCostMultiplier(
        provider.id,
        fallbackRate,
        provider.updatedAt
      );
      return {
        status: "failed",
        reason: "group_not_in_table",
        error,
        wrote,
        fallbackApplied: wrote,
        fallbackRate,
        ...(wrote ? {} : { fallbackError: "provider_changed" as const }),
      };
    }
    return { status: "failed", reason: "group_not_in_table", error, wrote: false };
  }

  const finalRate = applyMarkup(rate, provider.rateMarkupType, provider.rateMarkupValue);
  const wrote = await updateUpstreamBillingProbeResult(
    provider.id,
    {
      costMultiplier: finalRate,
      upstreamRateMultiplier: rate,
      syncedAt: new Date(),
      // Only persist a detected-group snapshot when it came from consume logs.
      // A configured fallback is effective for this sync, but was not actually observed.
      ...(observedGroup !== null ? { detectedGroup: observedGroup } : {}),
    },
    provider.updatedAt
  );
  if (!wrote) {
    return { status: "failed", reason: "provider_changed", wrote: false };
  }
  logger.debug("[UpstreamBilling] newapi pricing source selected", {
    providerId: provider.id,
    source: pricingSource,
  });
  return { status: "synced", upstreamRate: rate, finalRate, wrote: true };
}
