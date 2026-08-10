import {
  fetchNewapiRatioTable,
  type NewapiProbeRequestContext,
  type NewapiRatioTableResult,
} from "@/lib/upstream-billing/newapi-client";
import { buildNewapiBaseUrl } from "@/lib/upstream-billing/newapi-url";
import type { Provider } from "@/types/provider";

/**
 * new-api 分组倍率表的进程内缓存（按站点根地址）。
 *
 * 背景：同一 new-api 站点可能接入多个 provider（多把 sk-），/api/pricing 的
 * group_ratio 是站点级数据；匿名与 PAT 结果分别缓存，避免跨认证范围混用。
 *
 * 设计：
 * - TTL 60s：覆盖一轮探测 cycle 内的全部 worker（同站点只拉一次），下一轮必过期，
 *   保证站点管理员调整倍率值后能及时被感知；
 * - single-flight：同一站点的并发拉取合并为一个 Promise（调度器并发 worker 会同时
 *   命中未缓存的站点）；
 * - 只缓存成功结果，失败不缓存（下一个调用方立即重试）；
 * - 进程内即可：探测调度器持 Redis leader lock，全集群只有一个实例跑探测；
 *   UI「拉取分组」动作用 forceRefresh 绕过缓存。
 */

const TABLE_CACHE_TTL_MS = 60_000;

interface TableCacheEntry {
  table: Record<string, number>;
  expiresAt: number;
}

const cacheState = globalThis as unknown as {
  __CCH_NEWAPI_TABLE_CACHE__?: Map<string, TableCacheEntry>;
  __CCH_NEWAPI_TABLE_INFLIGHT__?: Map<string, Promise<NewapiRatioTableResult>>;
};

function getCache(): Map<string, TableCacheEntry> {
  if (!cacheState.__CCH_NEWAPI_TABLE_CACHE__) {
    cacheState.__CCH_NEWAPI_TABLE_CACHE__ = new Map();
  }
  return cacheState.__CCH_NEWAPI_TABLE_CACHE__;
}

function getInflight(): Map<string, Promise<NewapiRatioTableResult>> {
  if (!cacheState.__CCH_NEWAPI_TABLE_INFLIGHT__) {
    cacheState.__CCH_NEWAPI_TABLE_INFLIGHT__ = new Map();
  }
  return cacheState.__CCH_NEWAPI_TABLE_INFLIGHT__;
}

export async function getNewapiRatioTable(
  provider: Provider,
  options: {
    forceRefresh?: boolean;
    context?: NewapiProbeRequestContext;
    authenticated?: boolean;
  } = {}
): Promise<NewapiRatioTableResult> {
  let cacheKey: string;
  if (options.context) {
    cacheKey = `${options.context.cacheKey}:${options.authenticated ? "pat" : "anonymous"}`;
  } else {
    try {
      cacheKey = `legacy:${buildNewapiBaseUrl(provider.url)}:anonymous`;
    } catch {
      return { ok: false, reason: "invalid", error: "provider url is not a valid URL" };
    }
  }

  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = getCache().get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return { ok: true, table: cached.table };
    }

    const inflight = getInflight().get(cacheKey);
    if (inflight) {
      return inflight;
    }
  }

  const request = fetchNewapiRatioTable(provider, {
    context: options.context,
    authenticated: options.authenticated,
  })
    .then((result) => {
      if (result.ok) {
        getCache().set(cacheKey, {
          table: result.table,
          expiresAt: Date.now() + TABLE_CACHE_TTL_MS,
        });
      }
      return result;
    })
    .finally(() => {
      // 仅清掉本轮自己的 inflight（forceRefresh 并发时避免误删后启动的请求）
      if (getInflight().get(cacheKey) === request) {
        getInflight().delete(cacheKey);
      }
    });

  getInflight().set(cacheKey, request);
  return request;
}

export function invalidateNewapiRatioTableCacheForSite(siteId: number): void {
  const prefix = `site:${siteId}:`;
  for (const key of getCache().keys()) {
    if (key.startsWith(prefix)) getCache().delete(key);
  }
  for (const key of getInflight().keys()) {
    if (key.startsWith(prefix)) getInflight().delete(key);
  }
}
