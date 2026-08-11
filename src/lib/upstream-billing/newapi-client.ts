import { z } from "zod";
import { logger } from "@/lib/logger";
import { createProxyAgentForProvider, type ProviderProxyConfig } from "@/lib/proxy-agent";
import { buildNewapiBaseUrl } from "@/lib/upstream-billing/newapi-url";
import type { Provider } from "@/types/provider";

/**
 * new-api 上游倍率探测客户端。
 *
 * 语义对齐已核实的新 api 行为（QuantumNous/new-api）：
 * - GET {站点根}/api/pricing：匿名可读（pricing 模块开启时），响应顶层 group_ratio 为
 *   组名->分组倍率 映射；匿名访问会被站点「用户可用分组」过滤，看不到的组视为缺失。
 *   模块关闭/需登录返回 403，非 new-api 站点返回 404，均归为 unsupported。
 *   Dashboard PAT 认证同时要求 New-Api-User 请求头携带该 PAT 所属用户的数字 UID。
 * - GET {站点根}/api/log/token：Authorization: Bearer sk-...，返回该 key 的近期日志
 *   （按 id 倒序），取消费日志（type=2 且 group 非空）前 20 条求众数作为实际落组分组。
 *   站点可关闭消费日志（返回空），此时 group 为 null —— 不是失败。
 *
 * 两个端点共享代理/直连回退与超时策略（与 sub2api 探测客户端一致），不做重试，
 * 失败退避由调用方（同步/调度器）决定。
 */

const NEWAPI_PROBE_TIMEOUT_MS = 10_000;

const MAX_UPSTREAM_ERROR_LENGTH = 500;

// new-api model/log.go：消费日志类型值（其一注释明确 "don't use iota, avoid change"）
const NEWAPI_LOG_TYPE_CONSUME = 2;

// 众数窗口：最近 N 条消费日志（防 auto 分组抖动）
const MODE_WINDOW_SIZE = 20;

// /api/pricing 响应中仅强制 group_ratio，其余字段宽容忽略（向前兼容协议演进）
const pricingResponseSchema = z
  .object({
    group_ratio: z.record(z.string(), z.number()),
  })
  .loose();

// /api/log/token 响应：{ success, message, data: Log[] }；Log 仅消费 type/group 两个字段
const tokenLogsResponseSchema = z
  .object({
    success: z.boolean(),
    message: z.string().optional(),
    data: z
      .array(
        z
          .object({
            type: z.number(),
            group: z.string(),
          })
          .loose()
      )
      .nullable()
      .optional(),
  })
  .loose();

const dashboardIdentityResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ id: z.number() }).loose(),
  })
  .loose();

const newapiErrorEnvelopeSchema = z
  .object({
    success: z.boolean().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    error: z.union([z.string(), z.object({ message: z.string().optional() }).loose()]).optional(),
  })
  .loose();

export type NewapiProbeFailureReason =
  | "unsupported" // 端点不存在（404）或 pricing 模块关闭/需登录（403）
  | "auth" // Provider sk 或 Dashboard PAT 被拒绝（HTTP 401/403）
  | "rate_limited" // 触发 CriticalRateLimit（HTTP 429）
  | "http" // 其他非 2xx
  | "invalid" // 响应不是合法 JSON 或缺少必需字段
  | "timeout"
  | "network";

export type NewapiRatioTableResult =
  | { ok: true; table: Record<string, number> }
  | { ok: false; reason: NewapiProbeFailureReason; error?: string; status?: number };

export type NewapiTokenGroupResult =
  | { ok: true; group: string | null }
  | { ok: false; reason: NewapiProbeFailureReason; error?: string; status?: number };

export type NewapiPatTestStage = "identity" | "pricing";

/**
 * Request destination resolved by the site-owned probe configuration. The cache key must not
 * include any credential material.
 */
export interface NewapiProbeRequestContext {
  baseUrl: string;
  cacheKey: string;
  siteId: number | null;
  proxyConfig: ProviderProxyConfig;
  dashboardPat: string | null;
  dashboardUserId: number | null;
}

export type NewapiPatTestResult =
  | { ok: true; groupCount: number }
  | {
      ok: false;
      stage: NewapiPatTestStage;
      reason: NewapiProbeFailureReason;
      error?: string;
      status?: number;
    };

interface NewapiRatioTableOptions {
  context?: NewapiProbeRequestContext;
  authenticated?: boolean;
}

function isValidDashboardUserId(value: number | null | undefined): value is number {
  return Number.isInteger(value) && value != null && value > 0 && value <= 2_147_483_647;
}

function resolveRequestTarget(
  provider: Provider,
  context?: NewapiProbeRequestContext
): { baseUrl: string; proxyConfig: ProviderProxyConfig } | null {
  if (context) {
    return {
      baseUrl: context.baseUrl.replace(/\/$/, ""),
      proxyConfig: context.proxyConfig,
    };
  }
  try {
    return { baseUrl: buildNewapiBaseUrl(provider.url), proxyConfig: provider };
  } catch {
    return null;
  }
}

// 尽力而为地释放未消费的响应体，避免 undici 连接被挂起直到 GC
async function releaseResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 释放失败不影响探测结果判定
  }
}

function sanitizeUpstreamError(
  value: string,
  sensitiveValues: Array<string | null | undefined> = []
): string | undefined {
  let sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) return undefined;

  for (const sensitiveValue of sensitiveValues) {
    const secret = sensitiveValue?.trim();
    if (secret) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  return sanitized.slice(0, MAX_UPSTREAM_ERROR_LENGTH);
}

function extractUpstreamError(
  body: unknown,
  sensitiveValues: Array<string | null | undefined> = []
): string | undefined {
  if (typeof body === "string") return sanitizeUpstreamError(body, sensitiveValues);

  const parsed = newapiErrorEnvelopeSchema.safeParse(body);
  if (!parsed.success) return undefined;

  const nestedError =
    typeof parsed.data.error === "string" ? parsed.data.error : parsed.data.error?.message;
  const message = parsed.data.message || nestedError;
  const detail =
    parsed.data.code && message ? `${parsed.data.code}: ${message}` : parsed.data.code || message;
  return detail ? sanitizeUpstreamError(detail, sensitiveValues) : undefined;
}

async function readUpstreamError(
  response: Response,
  sensitiveValues: Array<string | null | undefined> = []
): Promise<string | undefined> {
  try {
    const bodyText = await response.text();
    if (!bodyText) return undefined;
    try {
      return (
        extractUpstreamError(JSON.parse(bodyText), sensitiveValues) ??
        sanitizeUpstreamError(bodyText, sensitiveValues)
      );
    } catch {
      return sanitizeUpstreamError(bodyText, sensitiveValues);
    }
  } catch {
    await releaseResponseBody(response);
    return undefined;
  }
}

interface UndiciFetchOptions extends RequestInit {
  dispatcher?: unknown;
}

/**
 * 带代理/直连回退的 GET（与 sub2api 探测客户端同一策略）：
 * 代理配置错误、代理请求失败、407 时按 proxyFallbackToDirect 决定是否回退直连。
 */
async function fetchWithProxyFallback(
  requestOwner: ProviderProxyConfig,
  url: string,
  headers: Record<string, string>
): Promise<
  { ok: true; response: Response } | { ok: false; reason: "timeout" | "network"; error: string }
> {
  const createFetchInit = (dispatcher?: unknown): UndiciFetchOptions => ({
    method: "GET",
    headers,
    signal: AbortSignal.timeout(NEWAPI_PROBE_TIMEOUT_MS),
    ...(dispatcher ? { dispatcher } : {}),
  });

  const toRequestFailure = (error: unknown) => {
    const err = error as Error & { name?: string };
    const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
    logger.warn("[NewapiProbe] request failed", {
      providerId: requestOwner.id,
      url,
      error: err.message,
      timeout: isTimeout,
    });
    return {
      ok: false as const,
      reason: (isTimeout ? "timeout" : "network") as "timeout" | "network",
      error: err.message,
    };
  };

  let proxy: ReturnType<typeof createProxyAgentForProvider> = null;
  try {
    proxy = createProxyAgentForProvider(requestOwner, url);
  } catch (error) {
    if (!requestOwner.proxyFallbackToDirect) {
      return toRequestFailure(error);
    }
    logger.warn("[NewapiProbe] proxy setup failed, falling back to direct", {
      providerId: requestOwner.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let response: Response;
  try {
    response = await fetch(url, createFetchInit(proxy?.agent));
  } catch (error) {
    if (!proxy?.fallbackToDirect) {
      return toRequestFailure(error);
    }
    logger.warn("[NewapiProbe] proxy request failed, falling back to direct", {
      providerId: requestOwner.id,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      response = await fetch(url, createFetchInit());
    } catch (fallbackError) {
      return toRequestFailure(fallbackError);
    }
  }

  if (response.status === 407 && proxy?.fallbackToDirect) {
    logger.warn("[NewapiProbe] proxy authentication failed, falling back to direct", {
      providerId: requestOwner.id,
    });
    await releaseResponseBody(response);
    try {
      response = await fetch(url, createFetchInit());
    } catch (fallbackError) {
      return toRequestFailure(fallbackError);
    }
  }

  return { ok: true, response };
}

/**
 * 拉取 new-api 站点的分组倍率表（匿名或 Dashboard PAT GET /api/pricing）。
 * 调用方负责缓存（见 newapi-table-cache.ts），本函数每次都会发请求。
 */
export async function fetchNewapiRatioTable(
  provider: Provider,
  options: NewapiRatioTableOptions = {}
): Promise<NewapiRatioTableResult> {
  const target = resolveRequestTarget(provider, options.context);
  if (!target) {
    return { ok: false, reason: "invalid", error: "provider url is not a valid URL" };
  }
  const url = `${target.baseUrl}/api/pricing`;

  const dashboardPat = options.authenticated ? options.context?.dashboardPat?.trim() : null;
  if (options.authenticated && !dashboardPat) {
    return { ok: false, reason: "auth", error: "site PAT is not configured" };
  }
  const dashboardUserId = options.authenticated ? options.context?.dashboardUserId : null;
  if (options.authenticated && !isValidDashboardUserId(dashboardUserId)) {
    return { ok: false, reason: "auth", error: "site new-api user UID is not configured" };
  }

  const fetched = await fetchWithProxyFallback(
    target.proxyConfig,
    url,
    dashboardPat && dashboardUserId != null
      ? {
          Authorization: `Bearer ${dashboardPat}`,
          "New-Api-User": String(dashboardUserId),
        }
      : {}
  );
  if (!fetched.ok) {
    return fetched;
  }
  const { response } = fetched;

  if (!response.ok) {
    const status = response.status;
    const error = await readUpstreamError(response, [dashboardPat]);
    if (status === 401 || (status === 403 && dashboardPat)) {
      return { ok: false, reason: "auth", status, ...(error ? { error } : {}) };
    }
    // pricing 模块关闭/需登录（403）与端点不存在（404）都意味着无法匿名取表
    if (status === 403 || status === 404) {
      return { ok: false, reason: "unsupported", status, ...(error ? { error } : {}) };
    }
    if (status === 429) {
      return { ok: false, reason: "rate_limited", status, ...(error ? { error } : {}) };
    }
    return { ok: false, reason: "http", status, error: error ?? `HTTP ${status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid", error: "response is not valid JSON" };
  }

  const parsed = pricingResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      error: extractUpstreamError(body, [dashboardPat]) ?? "missing group_ratio",
    };
  }

  return { ok: true, table: parsed.data.group_ratio };
}

/**
 * 从消费日志求众数分组：仅统计消费日志（type=2）且 group 非空的条目，
 * 取前 MODE_WINDOW_SIZE 条；并列时取先出现者（日志按 id 倒序，先出现即更新）。
 */
export function resolveModeGroupFromLogs(
  logs: Array<{ type: number; group: string }>
): string | null {
  const counts = new Map<string, { count: number; firstIndex: number }>();
  let windowSize = 0;

  for (const log of logs) {
    if (windowSize >= MODE_WINDOW_SIZE) {
      break;
    }
    if (log.type !== NEWAPI_LOG_TYPE_CONSUME) {
      continue;
    }
    const group = log.group.trim();
    if (!group) {
      continue;
    }
    const entry = counts.get(group);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(group, { count: 1, firstIndex: windowSize });
    }
    windowSize += 1;
  }

  let best: { group: string; count: number; firstIndex: number } | null = null;
  for (const [group, entry] of counts) {
    if (
      best === null ||
      entry.count > best.count ||
      (entry.count === best.count && entry.firstIndex < best.firstIndex)
    ) {
      best = { group, count: entry.count, firstIndex: entry.firstIndex };
    }
  }
  return best?.group ?? null;
}

/**
 * 用 sk- 探测该 key 的实际落组分组（GET /api/log/token 求众数）。
 * ok && group===null 表示无可用日志（新 key 冷启动或站点关闭了消费日志），不是失败。
 */
export async function fetchNewapiTokenGroup(
  provider: Provider,
  context?: NewapiProbeRequestContext
): Promise<NewapiTokenGroupResult> {
  const target = resolveRequestTarget(provider, context);
  if (!target) {
    return { ok: false, reason: "invalid", error: "provider url is not a valid URL" };
  }
  const url = `${target.baseUrl}/api/log/token`;

  // 该端点走 TokenAuthReadOnly，恒用 Bearer sk-（与 providerType 无关）
  const fetched = await fetchWithProxyFallback(target.proxyConfig, url, {
    Authorization: `Bearer ${provider.key}`,
  });
  if (!fetched.ok) {
    return fetched;
  }
  const { response } = fetched;

  if (!response.ok) {
    const status = response.status;
    const error = await readUpstreamError(response, [provider.key]);
    if (status === 401 || status === 403) {
      return { ok: false, reason: "auth", status, ...(error ? { error } : {}) };
    }
    if (status === 404) {
      return { ok: false, reason: "unsupported", status, ...(error ? { error } : {}) };
    }
    if (status === 429) {
      return { ok: false, reason: "rate_limited", status, ...(error ? { error } : {}) };
    }
    return { ok: false, reason: "http", status, error: error ?? `HTTP ${status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid", error: "response is not valid JSON" };
  }

  const parsed = tokenLogsResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      error: extractUpstreamError(body, [provider.key]) ?? "missing log data",
    };
  }
  if (parsed.data.success !== true) {
    // new-api 约定 200 + success:false（如令牌无效）
    return {
      ok: false,
      reason: "auth",
      error:
        sanitizeUpstreamError(parsed.data.message ?? "token rejected", [provider.key]) ??
        "token rejected",
    };
  }

  const logs = parsed.data.data ?? [];
  return { ok: true, group: resolveModeGroupFromLogs(logs) };
}

/** Validate a dashboard PAT against the user identity and authenticated pricing endpoints. */
export async function testNewapiDashboardPat(
  provider: Provider,
  context: NewapiProbeRequestContext
): Promise<NewapiPatTestResult> {
  const dashboardPat = context.dashboardPat?.trim();
  if (!dashboardPat) {
    return {
      ok: false,
      stage: "identity",
      reason: "auth",
      error: "site PAT is not configured",
    };
  }
  const dashboardUserId = context.dashboardUserId;
  if (!isValidDashboardUserId(dashboardUserId)) {
    return {
      ok: false,
      stage: "identity",
      reason: "auth",
      error: "site new-api user UID is not configured",
    };
  }
  const target = resolveRequestTarget(provider, context);
  if (!target) {
    return {
      ok: false,
      stage: "identity",
      reason: "invalid",
      error: "probe target is not a valid URL",
    };
  }

  const identityUrl = `${target.baseUrl}/api/user/self`;
  const fetched = await fetchWithProxyFallback(target.proxyConfig, identityUrl, {
    Authorization: `Bearer ${dashboardPat}`,
    "New-Api-User": String(dashboardUserId),
  });
  if (!fetched.ok) return { ...fetched, stage: "identity" };

  const { response } = fetched;
  if (!response.ok) {
    const status = response.status;
    const error = await readUpstreamError(response, [dashboardPat]);
    if (status === 401 || status === 403) {
      return { ok: false, stage: "identity", reason: "auth", status, ...(error ? { error } : {}) };
    }
    if (status === 404) {
      return {
        ok: false,
        stage: "identity",
        reason: "unsupported",
        status,
        ...(error ? { error } : {}),
      };
    }
    if (status === 429) {
      return {
        ok: false,
        stage: "identity",
        reason: "rate_limited",
        status,
        ...(error ? { error } : {}),
      };
    }
    return {
      ok: false,
      stage: "identity",
      reason: "http",
      status,
      error: error ?? `HTTP ${status}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      stage: "identity",
      reason: "invalid",
      error: "identity response is not valid JSON",
    };
  }
  const identity = dashboardIdentityResponseSchema.safeParse(body);
  if (!identity.success) {
    const envelope = newapiErrorEnvelopeSchema.safeParse(body);
    return {
      ok: false,
      stage: "identity",
      reason: envelope.success && envelope.data.success === false ? "auth" : "invalid",
      error: extractUpstreamError(body, [dashboardPat]) ?? "identity response is invalid",
    };
  }
  if (identity.data.data.id !== dashboardUserId) {
    return {
      ok: false,
      stage: "identity",
      reason: "auth",
      error: "new-api user UID does not match the PAT owner",
    };
  }

  const pricing = await fetchNewapiRatioTable(provider, { context, authenticated: true });
  if (!pricing.ok) return { ...pricing, stage: "pricing" };
  return { ok: true, groupCount: Object.keys(pricing.table).length };
}
