import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  stream?: Pick<ReadableStream, "cancel">;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: async () => init.body,
    body: init.stream ?? null,
  } as Response;
}

describe("probeUpstreamBilling", () => {
  const fetchMock = vi.fn();
  const createProxyAgentMock = vi.mocked(createProxyAgentForProvider);

  beforeEach(() => {
    fetchMock.mockReset();
    createProxyAgentMock.mockReset();
    createProxyAgentMock.mockReturnValue(null);
    vi.stubGlobal("fetch", fetchMock);
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

  it("marks HTTP 400 as unsupported", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 400 }));
    const result = await probeUpstreamBilling(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "unsupported" });
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

  it("marks other non-2xx as http failure", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 500 }));
    expect(await probeUpstreamBilling(makeProvider())).toMatchObject({
      ok: false,
      reason: "http",
      status: 500,
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
});
