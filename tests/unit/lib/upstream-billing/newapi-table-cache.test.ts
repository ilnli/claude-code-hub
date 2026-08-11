import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types/provider";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/proxy-agent", () => ({
  createProxyAgentForProvider: vi.fn(() => null),
}));

import {
  getNewapiRatioTable,
  invalidateNewapiRatioTableCacheForSite,
} from "@/lib/upstream-billing/newapi-table-cache";

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "newapi-upstream",
    url: "https://site-a.example.com/v1",
    key: "sk-test-key",
    providerType: "openai-compatible",
    proxyUrl: null,
    proxyFallbackToDirect: false,
    ...overrides,
  } as Provider;
}

function makePricingResponse(groupRatio: Record<string, number>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: [], group_ratio: groupRatio }),
    body: null,
  } as unknown as Response;
}

describe("getNewapiRatioTable 缓存", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("TTL 内同站点只拉取一次", async () => {
    const url = `https://ttl-${Date.now()}.example.com/v1`;
    fetchMock.mockResolvedValue(makePricingResponse({ default: 1 }));

    const p = makeProvider({ url });
    const first = await getNewapiRatioTable(p);
    const second = await getNewapiRatioTable(p);

    expect(first).toEqual({ ok: true, table: { default: 1 } });
    expect(second).toEqual({ ok: true, table: { default: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("并发请求合并为一次拉取（single-flight）", async () => {
    const url = `https://sf-${Date.now()}.example.com/v1`;
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const p1 = makeProvider({ id: 1, url });
    const p2 = makeProvider({ id: 2, url });
    const p3 = makeProvider({ id: 3, url });

    const pending = [getNewapiRatioTable(p1), getNewapiRatioTable(p2), getNewapiRatioTable(p3)];
    resolveFetch(makePricingResponse({ vip: 0.5 }));
    const results = await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toEqual({ ok: true, table: { vip: 0.5 } });
    }
  });

  it("失败结果不缓存，下一次调用立即重试", async () => {
    const url = `https://fail-${Date.now()}.example.com/v1`;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), body: null })
      .mockResolvedValueOnce(makePricingResponse({ default: 2 }));

    const p = makeProvider({ url });
    const first = await getNewapiRatioTable(p);
    expect(first).toMatchObject({ ok: false, reason: "http" });

    const second = await getNewapiRatioTable(p);
    expect(second).toEqual({ ok: true, table: { default: 2 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh 绕过缓存", async () => {
    const url = `https://fr-${Date.now()}.example.com/v1`;
    fetchMock
      .mockResolvedValueOnce(makePricingResponse({ default: 1 }))
      .mockResolvedValueOnce(makePricingResponse({ default: 3 }));

    const p = makeProvider({ url });
    await getNewapiRatioTable(p);
    const refreshed = await getNewapiRatioTable(p, { forceRefresh: true });

    expect(refreshed).toEqual({ ok: true, table: { default: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("不同站点（origin）各自独立缓存", async () => {
    const ts = Date.now();
    const urlA = `https://origin-a-${ts}.example.com/v1`;
    const urlB = `https://origin-b-${ts}.example.com/v1`;
    fetchMock
      .mockResolvedValueOnce(makePricingResponse({ default: 1 }))
      .mockResolvedValueOnce(makePricingResponse({ default: 9 }));

    const resultA = await getNewapiRatioTable(makeProvider({ url: urlA }));
    const resultB = await getNewapiRatioTable(makeProvider({ url: urlB }));

    expect(resultA).toEqual({ ok: true, table: { default: 1 } });
    expect(resultB).toEqual({ ok: true, table: { default: 9 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("同一站点的 PAT 与匿名结果使用独立缓存", async () => {
    const context = {
      baseUrl: "https://cache-scopes.example.com",
      cacheKey: `site:501:${Date.now()}`,
      siteId: 501,
      proxyConfig: { id: 501, proxyUrl: null, proxyFallbackToDirect: false },
      dashboardPat: "pat-secret",
      dashboardUserId: 501,
    };
    fetchMock
      .mockResolvedValueOnce(makePricingResponse({ vip: 0.5 }))
      .mockResolvedValueOnce(makePricingResponse({ default: 1 }));

    const pat = await getNewapiRatioTable(makeProvider(), { context, authenticated: true });
    const anonymous = await getNewapiRatioTable(makeProvider(), { context });

    expect(pat).toEqual({ ok: true, table: { vip: 0.5 } });
    expect(anonymous).toEqual({ ok: true, table: { default: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: "Bearer pat-secret",
      "New-Api-User": "501",
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({});
  });

  it("站点配置保存后可失效该站点的缓存", async () => {
    const context = {
      baseUrl: "https://invalidate.example.com",
      cacheKey: `site:777:${Date.now()}`,
      siteId: 777,
      proxyConfig: { id: 777, proxyUrl: null, proxyFallbackToDirect: false },
      dashboardPat: null,
      dashboardUserId: null,
    };
    fetchMock
      .mockResolvedValueOnce(makePricingResponse({ default: 1 }))
      .mockResolvedValueOnce(makePricingResponse({ default: 2 }));

    await getNewapiRatioTable(makeProvider(), { context });
    invalidateNewapiRatioTableCacheForSite(777);
    const refreshed = await getNewapiRatioTable(makeProvider(), { context });

    expect(refreshed).toEqual({ ok: true, table: { default: 2 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("provider URL 非法 -> invalid 且不发请求", async () => {
    const result = await getNewapiRatioTable(makeProvider({ url: "not-a-url" }));
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
