import { z } from "zod";
import { GeminiAuth } from "@/app/v1/_lib/gemini/auth";
import { resolveAnthropicAuthHeaders } from "@/app/v1/_lib/headers";
import { logger } from "@/lib/logger";
import { createProxyAgentForProvider } from "@/lib/proxy-agent";
import { buildUpstreamBillingUrl } from "@/lib/upstream-billing/billing-url";
import { isValidUpstreamRate, roundRate4 } from "@/lib/upstream-billing/rate-resolver";
import {
  inspectUpstreamResponse,
  type UpstreamEdgeProvider,
} from "@/lib/upstream-billing/response-diagnostics";
import type { Provider } from "@/types/provider";

/**
 * 上游 sub2api 计费探测客户端：GET {版本根}/sub2api/billing
 *
 * 语义对齐 sub2api 的 UpstreamBillingProbeService：
 * - 只消费 resolved_rate_multiplier（不读 effective_rate_multiplier，
 *   避免把探测瞬间的高峰因子固化进静态列）；
 * - 响应做严格校验，倍率必须在 (0, 100]；
 * - 任何失败都由调用方决定退避策略，本函数不做重试。
 */

const UPSTREAM_BILLING_PROBE_TIMEOUT_MS = 10_000;

// 响应中仅强制 resolved_rate_multiplier，其余字段宽容忽略（向前兼容协议演进）
const upstreamBillingResponseSchema = z
  .object({
    resolved_rate_multiplier: z.number(),
  })
  .loose();

export type UpstreamBillingProbeFailureReason =
  | "unsupported" // 上游不是 sub2api / 未实现探测端点（HTTP 404）
  | "auth" // 凭证被拒绝（HTTP 401/403）
  | "edge_blocked" // Cloudflare/WAF 返回拦截页或 challenge
  | "http" // 其他非 2xx（含瞬时 HTTP 400，按 3 次失败宽限期处理，不立即判定为 unsupported）
  | "invalid" // 响应不是合法 JSON 或缺少/越界 resolved_rate_multiplier
  | "timeout"
  | "network";

export type UpstreamBillingProbeResult =
  | { ok: true; rate: number }
  | {
      ok: false;
      reason: UpstreamBillingProbeFailureReason;
      error?: string;
      status?: number;
      edgeProvider?: UpstreamEdgeProvider;
      requestId?: string;
    };

// 尽力而为地释放未消费的响应体，避免 undici 连接被挂起直到 GC
async function releaseResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 释放失败不影响探测结果判定
  }
}

async function buildAuthHeaders(provider: Provider): Promise<Record<string, string>> {
  switch (provider.providerType) {
    case "claude":
      return resolveAnthropicAuthHeaders(provider.key, provider.url);
    case "claude-auth":
      return resolveAnthropicAuthHeaders(provider.key, provider.url, { forceBearerOnly: true });
    case "gemini":
    case "gemini-cli": {
      // provider.key 对 gemini-cli 而言常是 OAuth 凭据 JSON（含 refresh_token/client_secret）。
      // 复用转发器同款的 GeminiAuth 换取短期 access token，避免把长期凭据原样发给上游。
      const accessToken = await GeminiAuth.getAccessToken(provider.key);
      const isApiKey = GeminiAuth.isApiKey(provider.key);
      return isApiKey
        ? { "x-goog-api-key": accessToken }
        : { Authorization: `Bearer ${accessToken}` };
    }
    default:
      // codex / openai-compatible
      return { Authorization: `Bearer ${provider.key}` };
  }
}

export async function probeUpstreamBilling(
  provider: Provider
): Promise<UpstreamBillingProbeResult> {
  let billingUrl: string;
  try {
    billingUrl = buildUpstreamBillingUrl(provider.url);
  } catch {
    return { ok: false, reason: "invalid", error: "provider url is not a valid URL" };
  }

  const headers = await buildAuthHeaders(provider);

  // 通用 fetch 选项（undici 兼容），复用 provider 出站代理配置
  interface UndiciFetchOptions extends RequestInit {
    dispatcher?: unknown;
  }

  const createFetchInit = (dispatcher?: unknown): UndiciFetchOptions => ({
    method: "GET",
    headers,
    signal: AbortSignal.timeout(UPSTREAM_BILLING_PROBE_TIMEOUT_MS),
    ...(dispatcher ? { dispatcher } : {}),
  });

  const toRequestFailure = (error: unknown): UpstreamBillingProbeResult => {
    const err = error as Error & { name?: string };
    const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
    logger.warn("[UpstreamBillingProbe] request failed", {
      providerId: provider.id,
      error: err.message,
      timeout: isTimeout,
    });
    return { ok: false, reason: isTimeout ? "timeout" : "network", error: err.message };
  };

  let proxy: ReturnType<typeof createProxyAgentForProvider> = null;
  try {
    proxy = createProxyAgentForProvider(provider, billingUrl);
  } catch (error) {
    if (!provider.proxyFallbackToDirect) {
      return toRequestFailure(error);
    }
    logger.warn("[UpstreamBillingProbe] proxy setup failed, falling back to direct", {
      providerId: provider.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let response: Response;
  try {
    response = await fetch(billingUrl, createFetchInit(proxy?.agent));
  } catch (error) {
    if (!proxy?.fallbackToDirect) {
      return toRequestFailure(error);
    }

    logger.warn("[UpstreamBillingProbe] proxy request failed, falling back to direct", {
      providerId: provider.id,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      response = await fetch(billingUrl, createFetchInit());
    } catch (fallbackError) {
      return toRequestFailure(fallbackError);
    }
  }

  if (response.status === 407 && proxy?.fallbackToDirect) {
    logger.warn("[UpstreamBillingProbe] proxy authentication failed, falling back to direct", {
      providerId: provider.id,
    });
    await releaseResponseBody(response);
    try {
      response = await fetch(billingUrl, createFetchInit());
    } catch (fallbackError) {
      return toRequestFailure(fallbackError);
    }
  }

  const diagnostics = await inspectUpstreamResponse(response, [provider.key]);
  const edgeMetadata = {
    ...(diagnostics.edgeProvider ? { edgeProvider: diagnostics.edgeProvider } : {}),
    ...(diagnostics.requestId ? { requestId: diagnostics.requestId } : {}),
  };
  if (diagnostics.edgeBlocked) {
    return {
      ok: false,
      reason: "edge_blocked",
      status: response.status,
      error: diagnostics.error,
      ...edgeMetadata,
    };
  }

  if (!response.ok) {
    const status = response.status;
    if (status === 404) {
      return {
        ok: false,
        reason: "unsupported",
        status,
        ...(diagnostics.error ? { error: diagnostics.error } : {}),
        ...edgeMetadata,
      };
    }
    if (status === 401 || status === 403) {
      return {
        ok: false,
        reason: "auth",
        status,
        ...(diagnostics.error ? { error: diagnostics.error } : {}),
        ...edgeMetadata,
      };
    }
    return {
      ok: false,
      reason: "http",
      status,
      error: diagnostics.error ?? `HTTP ${status}`,
      ...edgeMetadata,
    };
  }

  if (!diagnostics.jsonParsed) {
    return {
      ok: false,
      reason: "invalid",
      error: diagnostics.error ?? "response is not valid JSON",
      ...edgeMetadata,
    };
  }

  const parsed = upstreamBillingResponseSchema.safeParse(diagnostics.body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      error: diagnostics.error ?? "missing resolved_rate_multiplier",
      ...edgeMetadata,
    };
  }

  const rate = parsed.data.resolved_rate_multiplier;
  if (!isValidUpstreamRate(rate)) {
    return {
      ok: false,
      reason: "invalid",
      error: `resolved_rate_multiplier out of range (0, 100]: ${rate}`,
      ...edgeMetadata,
    };
  }

  return { ok: true, rate: roundRate4(rate) };
}
