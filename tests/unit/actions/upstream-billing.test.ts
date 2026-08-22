import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types/provider";

let getSessionMock: ReturnType<typeof vi.fn>;
let findProviderByIdMock: ReturnType<typeof vi.fn>;
let syncAndTrackProviderUpstreamRateMock: ReturnType<typeof vi.fn>;
let publishInvalidationMock: ReturnType<typeof vi.fn>;
let getNewapiRatioTableMock: ReturnType<typeof vi.fn>;
let resolveNewapiProbeRequestContextMock: ReturnType<typeof vi.fn>;
let isValidProxyUrlMock: ReturnType<typeof vi.fn>;
let validateProviderUrlForConnectivityMock: ReturnType<typeof vi.fn>;
let loggerWarnMock: ReturnType<typeof vi.fn>;
let loggerInfoMock: ReturnType<typeof vi.fn>;

vi.mock("@/lib/auth", () => ({
  getSession: () => getSessionMock(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: (...args: unknown[]) => loggerInfoMock(...args),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/upstream-billing/probe-scheduler", () => ({
  syncAndTrackProviderUpstreamRate: (...args: unknown[]) =>
    syncAndTrackProviderUpstreamRateMock(...args),
}));

vi.mock("@/lib/cache/provider-cache", () => ({
  publishProviderCacheInvalidation: (...args: unknown[]) => publishInvalidationMock(...args),
}));

vi.mock("@/lib/proxy-agent", () => ({
  isValidProxyUrl: (...args: unknown[]) => isValidProxyUrlMock(...args),
}));

vi.mock("@/lib/upstream-billing/newapi-table-cache", () => ({
  getNewapiRatioTable: (...args: unknown[]) => getNewapiRatioTableMock(...args),
}));

vi.mock("@/lib/upstream-billing/newapi-probe-context", () => ({
  resolveNewapiProbeRequestContext: (...args: unknown[]) =>
    resolveNewapiProbeRequestContextMock(...args),
}));

vi.mock("@/lib/validation/provider-url", () => ({
  validateProviderUrlForConnectivity: (...args: unknown[]) =>
    validateProviderUrlForConnectivityMock(...args),
}));

vi.mock("@/repository", () => ({
  findProviderById: (...args: unknown[]) => findProviderByIdMock(...args),
}));

import {
  fetchNewapiUpstreamGroups,
  syncProvidersUpstreamRateBatch,
  syncProviderUpstreamRateNow,
} from "@/actions/upstream-billing";

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "upstream",
    url: "https://upstream.example.com/v1",
    key: "sk-test",
    providerType: "claude",
    costMultiplier: 1.0,
    rateFollowUpstream: true,
    rateDefaultMultiplier: 1.0,
    rateMarkupType: "none",
    rateMarkupValue: 0,
    ...overrides,
  } as Provider;
}

function makeProbeContext(
  overrides: Partial<{
    baseUrl: string;
    cacheKey: string;
    siteId: number | null;
    proxyConfig: Provider;
    dashboardPat: string | null;
    dashboardUserId: number | null;
  }> = {}
) {
  return {
    baseUrl: "https://newapi.example.com",
    cacheKey: "legacy:https://newapi.example.com",
    siteId: null,
    proxyConfig: makeProvider(),
    dashboardPat: null,
    dashboardUserId: null,
    ...overrides,
  };
}

describe("syncProviderUpstreamRateNow", () => {
  beforeEach(() => {
    getSessionMock = vi.fn().mockResolvedValue({ user: { role: "admin" } });
    findProviderByIdMock = vi.fn();
    syncAndTrackProviderUpstreamRateMock = vi.fn();
    publishInvalidationMock = vi.fn().mockResolvedValue(undefined);
  });

  it("rejects non-admin callers", async () => {
    getSessionMock.mockResolvedValue({ user: { role: "user" } });
    const res = await syncProviderUpstreamRateNow(1);
    expect(res.ok).toBe(false);
    expect(syncAndTrackProviderUpstreamRateMock).not.toHaveBeenCalled();
  });

  it("rejects when provider not found", async () => {
    findProviderByIdMock.mockResolvedValue(null);
    const res = await syncProviderUpstreamRateNow(99);
    expect(res.ok).toBe(false);
  });

  it("rejects when follow-upstream is not enabled", async () => {
    findProviderByIdMock.mockResolvedValue(makeProvider({ rateFollowUpstream: false }));
    const res = await syncProviderUpstreamRateNow(1);
    expect(res.ok).toBe(false);
    expect(syncAndTrackProviderUpstreamRateMock).not.toHaveBeenCalled();
  });

  it("syncs and publishes invalidation on success", async () => {
    findProviderByIdMock.mockResolvedValue(makeProvider());
    syncAndTrackProviderUpstreamRateMock.mockResolvedValue({
      status: "synced",
      upstreamRate: 1.6,
      finalRate: 1.76,
      wrote: true,
    });

    const res = await syncProviderUpstreamRateNow(1);

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      providerId: 1,
      status: "synced",
      upstreamRate: 1.6,
      finalRate: 1.76,
    });
    expect(publishInvalidationMock).toHaveBeenCalled();
  });

  it("does not publish invalidation on failure", async () => {
    findProviderByIdMock.mockResolvedValue(makeProvider());
    syncAndTrackProviderUpstreamRateMock.mockResolvedValue({
      status: "failed",
      reason: "timeout",
      error: "boom",
      wrote: false,
    });

    const res = await syncProviderUpstreamRateNow(1);

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ status: "failed", error: "boom" });
    expect(publishInvalidationMock).not.toHaveBeenCalled();
  });

  it("returns structured Cloudflare diagnostics for manual sync failures", async () => {
    findProviderByIdMock.mockResolvedValue(makeProvider());
    syncAndTrackProviderUpstreamRateMock.mockResolvedValue({
      status: "failed",
      reason: "edge_blocked",
      error: "Cloudflare edge blocked or challenged the probe",
      httpStatus: 503,
      edgeProvider: "cloudflare",
      requestId: "ray-action",
      wrote: false,
    });

    const res = await syncProviderUpstreamRateNow(1);

    expect(res).toMatchObject({
      ok: true,
      data: {
        status: "failed",
        reason: "edge_blocked",
        httpStatus: 503,
        edgeProvider: "cloudflare",
        requestId: "ray-action",
      },
    });
  });
});

describe("syncProvidersUpstreamRateBatch", () => {
  beforeEach(() => {
    getSessionMock = vi.fn().mockResolvedValue({ user: { role: "admin" } });
    findProviderByIdMock = vi.fn();
    syncAndTrackProviderUpstreamRateMock = vi.fn();
    publishInvalidationMock = vi.fn().mockResolvedValue(undefined);
  });

  it("rejects empty selection", async () => {
    const res = await syncProvidersUpstreamRateBatch([]);
    expect(res.ok).toBe(false);
  });

  it("summarizes mixed outcomes and skips non-follow providers", async () => {
    findProviderByIdMock.mockImplementation(async (id: number) => {
      if (id === 1) return makeProvider({ id: 1, name: "p1" });
      if (id === 2) return makeProvider({ id: 2, name: "p2", rateFollowUpstream: false });
      if (id === 3) return makeProvider({ id: 3, name: "p3" });
      return null;
    });
    syncAndTrackProviderUpstreamRateMock.mockImplementation(async (provider: Provider) => {
      if (provider.id === 1) {
        return { status: "synced", upstreamRate: 1.1, finalRate: 1.21, wrote: true };
      }
      return { status: "failed", reason: "network", error: "boom", wrote: false };
    });

    const res = await syncProvidersUpstreamRateBatch([1, 2, 3, 99]);

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ total: 4, synced: 1, failed: 2, skipped: 1 });
    // 有成功写回时发布一次缓存失效
    expect(publishInvalidationMock).toHaveBeenCalledTimes(1);
    // 未开启跟随的 provider 不触发探测
    expect(syncAndTrackProviderUpstreamRateMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates repeated provider ids before probing", async () => {
    findProviderByIdMock.mockResolvedValue(makeProvider({ id: 1 }));
    syncAndTrackProviderUpstreamRateMock.mockResolvedValue({
      status: "synced",
      upstreamRate: 1.1,
      finalRate: 1.1,
      wrote: true,
    });

    const res = await syncProvidersUpstreamRateBatch([1, 1, 1]);

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ total: 1, synced: 1, failed: 0 });
    expect(findProviderByIdMock).toHaveBeenCalledTimes(1);
    expect(syncAndTrackProviderUpstreamRateMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchNewapiUpstreamGroups", () => {
  beforeEach(() => {
    getSessionMock = vi.fn().mockResolvedValue({ user: { role: "admin" } });
    getNewapiRatioTableMock = vi.fn();
    resolveNewapiProbeRequestContextMock = vi.fn().mockResolvedValue(makeProbeContext());
    isValidProxyUrlMock = vi.fn().mockReturnValue(true);
    loggerWarnMock = vi.fn();
    loggerInfoMock = vi.fn();
    validateProviderUrlForConnectivityMock = vi.fn().mockReturnValue({
      valid: true,
      normalizedUrl: "https://newapi.example.com/v1",
    });
  });

  it("rejects non-admin callers without probing upstream", async () => {
    getSessionMock.mockResolvedValue({ user: { role: "user" } });

    const result = await fetchNewapiUpstreamGroups({
      providerUrl: "https://newapi.example.com/v1",
    });

    expect(result.ok).toBe(false);
    expect(getNewapiRatioTableMock).not.toHaveBeenCalled();
  });

  it("validates the provider and proxy URLs before probing", async () => {
    validateProviderUrlForConnectivityMock.mockReturnValue({
      valid: false,
      error: { message: "invalid provider URL" },
    });

    const invalidProvider = await fetchNewapiUpstreamGroups({ providerUrl: "not-a-url" });
    expect(invalidProvider).toMatchObject({ ok: false, error: "invalid provider URL" });
    expect(getNewapiRatioTableMock).not.toHaveBeenCalled();

    validateProviderUrlForConnectivityMock.mockReturnValue({
      valid: true,
      normalizedUrl: "https://newapi.example.com/v1",
    });
    isValidProxyUrlMock.mockReturnValue(false);

    const invalidProxy = await fetchNewapiUpstreamGroups({
      providerUrl: "https://newapi.example.com/v1",
      proxyUrl: "bad-proxy",
    });
    expect(invalidProxy.ok).toBe(false);
    expect(getNewapiRatioTableMock).not.toHaveBeenCalled();
  });

  it("returns groups sorted by ratio and name using a forced refresh", async () => {
    getNewapiRatioTableMock.mockResolvedValue({
      ok: true,
      table: { vip: 0.8, default: 1, beta: 0.8 },
    });

    const result = await fetchNewapiUpstreamGroups({
      providerUrl: "https://newapi.example.com/v1",
      proxyUrl: "http://proxy.example.com:8080",
      proxyFallbackToDirect: true,
    });

    expect(result).toEqual({
      ok: true,
      data: {
        groups: [
          { name: "beta", ratio: 0.8 },
          { name: "vip", ratio: 0.8 },
          { name: "default", ratio: 1 },
        ],
      },
    });
    expect(getNewapiRatioTableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 0,
        url: "https://newapi.example.com/v1",
        upstreamSiteId: null,
        proxyUrl: "http://proxy.example.com:8080",
        proxyFallbackToDirect: true,
      }),
      {
        forceRefresh: true,
        context: expect.objectContaining({
          baseUrl: "https://newapi.example.com",
          dashboardPat: null,
          dashboardUserId: null,
        }),
        authenticated: false,
      }
    );
    expect(loggerInfoMock).toHaveBeenCalledWith("fetchNewapiUpstreamGroups:succeeded", {
      siteId: null,
      probeBaseUrl: "https://newapi.example.com",
      authentication: "anonymous",
      groupCount: 3,
    });
  });

  it("uses the matching upstream site's PAT and UID context", async () => {
    const siteContext = makeProbeContext({
      baseUrl: "https://newapi.example.com/management",
      cacheKey: "site:12:1234",
      siteId: 12,
      dashboardPat: "site-pat-must-not-be-logged",
      dashboardUserId: 84,
    });
    resolveNewapiProbeRequestContextMock.mockResolvedValue(siteContext);
    getNewapiRatioTableMock.mockResolvedValue({
      ok: true,
      table: { internal: 0.5, default: 1 },
    });

    const result = await fetchNewapiUpstreamGroups({
      providerUrl: "https://newapi.example.com/v1",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        groups: [
          { name: "internal", ratio: 0.5 },
          { name: "default", ratio: 1 },
        ],
      },
    });
    expect(resolveNewapiProbeRequestContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://newapi.example.com/v1",
        upstreamSiteId: null,
      })
    );
    expect(getNewapiRatioTableMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        forceRefresh: true,
        context: siteContext,
        authenticated: true,
      })
    );
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain("site-pat-must-not-be-logged");
  });

  it("reports unsupported upstream pricing tables", async () => {
    getNewapiRatioTableMock.mockResolvedValue({
      ok: false,
      reason: "unsupported",
      status: 404,
    });

    const result = await fetchNewapiUpstreamGroups({
      providerUrl: "https://newapi.example.com/v1",
    });

    expect(result.ok).toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith("fetchNewapiUpstreamGroups:failed", {
      siteId: null,
      probeBaseUrl: "https://newapi.example.com",
      authentication: "anonymous",
      reason: "unsupported",
      status: 404,
    });
  });
});
