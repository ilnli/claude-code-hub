import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiAuth } from "@/app/v1/_lib/gemini/auth";
import { createProxyAgentForProvider } from "@/lib/proxy-agent";
import type { Provider } from "@/types/provider";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/app/v1/_lib/headers", () => ({
  resolveAnthropicAuthHeaders: vi.fn((apiKey: string) => ({
    Authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
  })),
}));

// 与转发器测试同款：整体 mock GeminiAuth，避免 JSON 凭据分支触发真实的 OAuth 网络请求。
// beforeEach 中的默认实现模拟纯 API Key 场景，让既有用例无需感知这层 mock。
vi.mock("@/app/v1/_lib/gemini/auth", () => ({
  GeminiAuth: {
    getAccessToken: vi.fn(),
    isApiKey: vi.fn(),
  },
}));

vi.mock("@/lib/proxy-agent", () => ({
  createProxyAgentForProvider: vi.fn(() => null),
}));

import { probeUpstreamBilling } from "@/lib/upstream-billing/client";

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "upstream",
    url: "https://upstream.example.com/v1",
    key: "sk-test-key",
    providerType: "claude",
    proxyUrl: null,
    proxyFallbackToDirect: false,
    ...overrides,
  } as Provider;
}

function makeResponse(init: {
  ok: boolean;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  stream?: Pick<ReadableStream, "cancel">;
}): Response {
  const bodyText =
    init.body === undefined
      ? ""
      : typeof init.body === "string"
        ? init.body
        : JSON.stringify(init.body);
  return {
    ok: init.ok,
    status: init.status,
    json: async () => init.body,
    text: async () => bodyText,
    headers: new Headers(init.headers),
    body: init.stream ?? null,
  } as Response;
}

describe("probeUpstreamBilling", () => {
  const fetchMock = vi.fn();
  const createProxyAgentMock = vi.mocked(createProxyAgentForProvider);
  const geminiAuthMock = vi.mocked(GeminiAuth);

  beforeEach(() => {
    fetchMock.mockReset();
    createProxyAgentMock.mockReset();
    createProxyAgentMock.mockReturnValue(null);
    vi.stubGlobal("fetch", fetchMock);

    // 默认模拟 GeminiAuth 对纯 API Key 的真实行为：原样返回 key，判定为 isApiKey。
    geminiAuthMock.getAccessToken.mockReset();
    geminiAuthMock.isApiKey.mockReset();
    geminiAuthMock.getAccessToken.mockImplementation(async (key: string) => key);
    geminiAuthMock.isApiKey.mockImplementation(
      (key: string) => !key.trim().startsWith("{") && !key.startsWith("ya29.")
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns rounded rate on success", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          object: "sub2api.key_billing",
          schema_version: 1,
          resolved_rate_multiplier: 1.234567,
          effective_rate_multiplier: 2.5,
        },
      })
    );

    const result = await probeUpstreamBilling(makeProvider());

    expect(result).toEqual({ ok: true, rate: 1.2346 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://upstream.example.com/v1/sub2api/billing",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("sends provider-type specific auth headers", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ ok: true, status: 200, body: { resolved_rate_multiplier: 1 } })
    );

    await probeUpstreamBilling(makeProvider({ providerType: "openai-compatible", key: "sk-oai" }));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-oai" },
      })
    );

    await probeUpstreamBilling(makeProvider({ providerType: "gemini-cli", key: "gm-key" }));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { "x-goog-api-key": "gm-key" },
      })
    );
  });

  it("marks HTTP 404 as unsupported", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 404 }));
    const result = await probeUpstreamBilling(makeProvider());
    expect(result).toEqual({ ok: false, reason: "unsupported", status: 404 });
  });

  it("marks HTTP 400 as a generic http failure (not unsupported)", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 400 }));
    const result = await probeUpstreamBilling(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "http", status: 400 });
  });

  it("marks HTTP 401/403 as auth failure", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 401 }));
    expect(await probeUpstreamBilling(makeProvider())).toMatchObject({
      ok: false,
      reason: "auth",
    });

    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 403 }));
    expect(await probeUpstreamBilling(makeProvider())).toMatchObject({
      ok: false,
      reason: "auth",
    });
  });

  it("preserves Cloudflare request metadata when an API response is still classified as auth", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: false,
        status: 401,
        body: { message: "invalid token" },
        headers: {
          server: "cloudflare",
          "content-type": "application/json",
          "cf-ray": "ray-auth",
        },
      })
    );

    const result = await probeUpstreamBilling(makeProvider());

    expect(result).toMatchObject({
      ok: false,
      reason: "auth",
      status: 401,
      edgeProvider: "cloudflare",
      requestId: "ray-auth",
      error: "invalid token",
    });
  });

  it("marks other non-2xx as http failure", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 500 }));
    expect(await probeUpstreamBilling(makeProvider())).toMatchObject({
      ok: false,
      reason: "http",
      status: 500,
    });
  });

  it("consumes the response body for non-2xx responses to release the connection", async () => {
    const text = vi.fn().mockResolvedValue("upstream failed");
    fetchMock.mockResolvedValue({
      ...makeResponse({ ok: false, status: 500 }),
      text,
    });

    const result = await probeUpstreamBilling(makeProvider());

    expect(result).toMatchObject({ ok: false, reason: "http", status: 500 });
    expect(text).toHaveBeenCalledTimes(1);
  });

  it("classifies a Cloudflare challenge as edge_blocked and preserves CF-Ray", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: true,
        status: 200,
        body: "<!doctype html><title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/x'></script>",
        headers: {
          server: "cloudflare",
          "content-type": "text/html",
          "cf-mitigated": "challenge",
          "cf-ray": "abc123-SJC",
        },
      })
    );

    const result = await probeUpstreamBilling(makeProvider());

    expect(result).toMatchObject({
      ok: false,
      reason: "edge_blocked",
      status: 200,
      edgeProvider: "cloudflare",
      requestId: "abc123-SJC",
      error: expect.stringContaining("Cloudflare edge blocked or challenged"),
    });
  });

  it("rejects responses missing resolved_rate_multiplier", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ ok: true, status: 200, body: { object: "sub2api.key_billing" } })
    );
    expect(await probeUpstreamBilling(makeProvider())).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a null resolved_rate_multiplier", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ ok: true, status: 200, body: { resolved_rate_multiplier: null } })
    );

    expect(await probeUpstreamBilling(makeProvider())).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects out-of-range resolved_rate_multiplier (fail-closed)", async () => {
    for (const rate of [0, -1, 100.5]) {
      fetchMock.mockResolvedValue(
        makeResponse({ ok: true, status: 200, body: { resolved_rate_multiplier: rate } })
      );
      expect(await probeUpstreamBilling(makeProvider())).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("rejects non-JSON responses", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    expect(await probeUpstreamBilling(makeProvider())).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("marks fetch exceptions as network/timeout failures", async () => {
    fetchMock.mockRejectedValue(new Error("connect refused"));
    expect(await probeUpstreamBilling(makeProvider())).toMatchObject({
      ok: false,
      reason: "network",
    });

    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeoutError);
    expect(await probeUpstreamBilling(makeProvider())).toMatchObject({
      ok: false,
      reason: "timeout",
    });
  });

  it("falls back to a direct request when the configured proxy fails", async () => {
    const proxyAgent = { dispatch: vi.fn() };
    createProxyAgentMock.mockReturnValue({
      agent: proxyAgent as never,
      fallbackToDirect: true,
      proxyUrl: "http://proxy.example.com",
      http2Enabled: false,
    });
    fetchMock
      .mockRejectedValueOnce(new Error("proxy connection refused"))
      .mockResolvedValueOnce(
        makeResponse({ ok: true, status: 200, body: { resolved_rate_multiplier: 1.25 } })
      );

    const result = await probeUpstreamBilling(
      makeProvider({ proxyUrl: "http://proxy.example.com", proxyFallbackToDirect: true })
    );

    expect(result).toEqual({ ok: true, rate: 1.25 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ dispatcher: proxyAgent })
    );
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("dispatcher");
    expect(fetchMock.mock.calls[1]?.[1]?.signal).not.toBe(fetchMock.mock.calls[0]?.[1]?.signal);
  });

  it("releases a proxy 407 response before falling back to a direct request", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const proxyAgent = { dispatch: vi.fn() };
    createProxyAgentMock.mockReturnValue({
      agent: proxyAgent as never,
      fallbackToDirect: true,
      proxyUrl: "http://proxy.example.com",
      http2Enabled: false,
    });
    fetchMock
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 407, stream: { cancel } }))
      .mockResolvedValueOnce(
        makeResponse({ ok: true, status: 200, body: { resolved_rate_multiplier: 1.25 } })
      );

    const result = await probeUpstreamBilling(
      makeProvider({ proxyUrl: "http://proxy.example.com", proxyFallbackToDirect: true })
    );

    expect(result).toEqual({ ok: true, rate: 1.25 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("dispatcher");
    expect(fetchMock.mock.calls[1]?.[1]?.signal).not.toBe(fetchMock.mock.calls[0]?.[1]?.signal);
  });

  it("rejects invalid provider url", async () => {
    const result = await probeUpstreamBilling(makeProvider({ url: "not-a-url" }));
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("exchanges gemini-cli OAuth JSON credentials for an access token instead of sending them raw", async () => {
    const credentialsJson = JSON.stringify({
      refresh_token: "1//refresh-token",
      client_id: "client-id.apps.googleusercontent.com",
      client_secret: "client-secret",
    });
    geminiAuthMock.getAccessToken.mockResolvedValueOnce("ya29.exchanged-access-token");
    geminiAuthMock.isApiKey.mockReturnValueOnce(false);
    fetchMock.mockResolvedValue(
      makeResponse({ ok: true, status: 200, body: { resolved_rate_multiplier: 1 } })
    );

    const result = await probeUpstreamBilling(
      makeProvider({ providerType: "gemini-cli", key: credentialsJson })
    );

    expect(result).toEqual({ ok: true, rate: 1 });
    expect(geminiAuthMock.getAccessToken).toHaveBeenCalledWith(credentialsJson);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer ya29.exchanged-access-token" },
      })
    );

    const sentHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(Object.values(sentHeaders)).not.toContain(credentialsJson);
  });
});
