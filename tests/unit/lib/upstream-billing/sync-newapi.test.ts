import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types/provider";

let probeUpstreamBillingMock: ReturnType<typeof vi.fn>;
let getNewapiRatioTableMock: ReturnType<typeof vi.fn>;
let fetchNewapiTokenGroupMock: ReturnType<typeof vi.fn>;
let resolveNewapiProbeRequestContextMock: ReturnType<typeof vi.fn>;
let updateUpstreamBillingProbeResultMock: ReturnType<typeof vi.fn>;
let restoreProviderCostMultiplierMock: ReturnType<typeof vi.fn>;

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/upstream-billing/client", () => ({
  probeUpstreamBilling: (...args: unknown[]) => probeUpstreamBillingMock(...args),
}));

vi.mock("@/lib/upstream-billing/newapi-table-cache", () => ({
  getNewapiRatioTable: (...args: unknown[]) => getNewapiRatioTableMock(...args),
}));

vi.mock("@/lib/upstream-billing/newapi-client", () => ({
  fetchNewapiTokenGroup: (...args: unknown[]) => fetchNewapiTokenGroupMock(...args),
}));

vi.mock("@/lib/upstream-billing/newapi-probe-context", () => ({
  resolveNewapiProbeRequestContext: (...args: unknown[]) =>
    resolveNewapiProbeRequestContextMock(...args),
}));

vi.mock("@/repository", () => ({
  updateUpstreamBillingProbeResult: (...args: unknown[]) =>
    updateUpstreamBillingProbeResultMock(...args),
  restoreProviderCostMultiplier: (...args: unknown[]) => restoreProviderCostMultiplierMock(...args),
}));

import { syncProviderUpstreamRate } from "@/lib/upstream-billing/sync";

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 7,
    name: "newapi-upstream",
    url: "https://newapi.example.com/v1",
    key: "sk-test",
    providerType: "openai-compatible",
    costMultiplier: 1.0,
    rateFollowUpstream: true,
    rateDefaultMultiplier: 1.0,
    rateMarkupType: "none",
    rateMarkupValue: 0,
    upstreamRateMultiplier: null,
    rateUpstreamType: "newapi",
    newapiGroup: null,
    newapiDetectedGroup: null,
    updatedAt: new Date("2026-08-02T12:00:00.000Z"),
    ...overrides,
  } as Provider;
}

describe("syncProviderUpstreamRate (newapi)", () => {
  beforeEach(() => {
    probeUpstreamBillingMock = vi.fn();
    getNewapiRatioTableMock = vi.fn();
    fetchNewapiTokenGroupMock = vi.fn().mockResolvedValue({ ok: true, group: "default" });
    resolveNewapiProbeRequestContextMock = vi.fn().mockResolvedValue({
      baseUrl: "https://newapi.example.com",
      cacheKey: "site:1:1",
      siteId: 1,
      proxyConfig: { id: 1, proxyUrl: null, proxyFallbackToDirect: false },
      dashboardPat: null,
    });
    updateUpstreamBillingProbeResultMock = vi.fn().mockResolvedValue(true);
    restoreProviderCostMultiplierMock = vi.fn().mockResolvedValue(true);
  });

  it("非 newapi 类型走 sub2api 路径（分发正确）", async () => {
    probeUpstreamBillingMock.mockResolvedValue({ ok: true, rate: 1.5 });
    const outcome = await syncProviderUpstreamRate(makeProvider({ rateUpstreamType: "sub2api" }));

    expect(probeUpstreamBillingMock).toHaveBeenCalledTimes(1);
    expect(getNewapiRatioTableMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "synced", upstreamRate: 1.5 });
  });

  it("成功：日志观测分组优先，写回倍率与 detectedGroup 快照", async () => {
    getNewapiRatioTableMock.mockResolvedValue({
      ok: true,
      table: { default: 1, vip: 0.8 },
    });
    fetchNewapiTokenGroupMock.mockResolvedValue({ ok: true, group: "vip" });

    const outcome = await syncProviderUpstreamRate(
      makeProvider({ newapiGroup: "default", rateMarkupType: "percent", rateMarkupValue: 0.25 })
    );

    expect(outcome).toEqual({ status: "synced", upstreamRate: 0.8, finalRate: 1, wrote: true });
    expect(updateUpstreamBillingProbeResultMock).toHaveBeenCalledWith(
      7,
      {
        costMultiplier: 1,
        upstreamRateMultiplier: 0.8,
        syncedAt: expect.any(Date),
        detectedGroup: "vip",
      },
      new Date("2026-08-02T12:00:00.000Z")
    );
  });

  it("日志校准失败降级到配置分组，不阻塞同步", async () => {
    getNewapiRatioTableMock.mockResolvedValue({ ok: true, table: { default: 1.2 } });
    fetchNewapiTokenGroupMock.mockResolvedValue({ ok: false, reason: "auth", status: 401 });

    const outcome = await syncProviderUpstreamRate(makeProvider({ newapiGroup: "default" }));

    expect(outcome).toMatchObject({ status: "synced", upstreamRate: 1.2, finalRate: 1.2 });
    const probeResult = updateUpstreamBillingProbeResultMock.mock.calls[0]?.[1];
    expect(probeResult).not.toHaveProperty("detectedGroup");
  });

  it("PAT 倍率优先于匿名倍率", async () => {
    resolveNewapiProbeRequestContextMock.mockResolvedValue({
      baseUrl: "https://newapi.example.com",
      cacheKey: "site:1:2",
      siteId: 1,
      proxyConfig: { id: 1, proxyUrl: null, proxyFallbackToDirect: false },
      dashboardPat: "pat-secret",
    });
    fetchNewapiTokenGroupMock.mockResolvedValue({ ok: true, group: "vip" });
    getNewapiRatioTableMock.mockResolvedValue({ ok: true, table: { vip: 0.6 } });

    const outcome = await syncProviderUpstreamRate(makeProvider());

    expect(outcome).toMatchObject({ status: "synced", upstreamRate: 0.6 });
    expect(getNewapiRatioTableMock).toHaveBeenCalledTimes(1);
    expect(getNewapiRatioTableMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authenticated: true })
    );
  });

  it("PAT 请求失败时静默使用匿名倍率", async () => {
    resolveNewapiProbeRequestContextMock.mockResolvedValue({
      baseUrl: "https://newapi.example.com",
      cacheKey: "site:1:3",
      siteId: 1,
      proxyConfig: { id: 1, proxyUrl: null, proxyFallbackToDirect: false },
      dashboardPat: "pat-secret",
    });
    fetchNewapiTokenGroupMock.mockResolvedValue({ ok: true, group: "vip" });
    getNewapiRatioTableMock
      .mockResolvedValueOnce({ ok: false, reason: "auth", status: 401 })
      .mockResolvedValueOnce({ ok: true, table: { vip: 0.9 } });

    const outcome = await syncProviderUpstreamRate(makeProvider());

    expect(outcome).toMatchObject({ status: "synced", upstreamRate: 0.9 });
    expect(getNewapiRatioTableMock).toHaveBeenCalledTimes(2);
    expect(getNewapiRatioTableMock.mock.calls[1]?.[1]).toEqual({
      context: expect.objectContaining({ siteId: 1 }),
    });
  });

  it("空日志（冷启动）降级到配置分组", async () => {
    getNewapiRatioTableMock.mockResolvedValue({ ok: true, table: { svip: 0.5 } });
    fetchNewapiTokenGroupMock.mockResolvedValue({ ok: true, group: null });

    const outcome = await syncProviderUpstreamRate(makeProvider({ newapiGroup: "svip" }));

    expect(outcome).toMatchObject({ status: "synced", upstreamRate: 0.5 });
    const probeResult = updateUpstreamBillingProbeResultMock.mock.calls[0]?.[1];
    expect(probeResult).not.toHaveProperty("detectedGroup");
  });

  it("无日志且未配置分组 -> group_unknown，不写库", async () => {
    getNewapiRatioTableMock.mockResolvedValue({ ok: true, table: { default: 1 } });
    fetchNewapiTokenGroupMock.mockResolvedValue({ ok: true, group: null });

    const outcome = await syncProviderUpstreamRate(makeProvider());

    expect(outcome).toMatchObject({ status: "failed", reason: "group_unknown", wrote: false });
    expect(updateUpstreamBillingProbeResultMock).not.toHaveBeenCalled();
    expect(restoreProviderCostMultiplierMock).not.toHaveBeenCalled();
  });

  it("group_unknown 连续第三次失败后回退默认倍率", async () => {
    getNewapiRatioTableMock.mockResolvedValue({ ok: true, table: { default: 1 } });
    fetchNewapiTokenGroupMock.mockResolvedValue({ ok: true, group: null });

    const provider = makeProvider({
      costMultiplier: 1.6,
      rateDefaultMultiplier: 1.2,
      upstreamRateMultiplier: 1.6,
    });
    const outcome = await syncProviderUpstreamRate(provider, { consecutiveFailureCount: 3 });

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "group_unknown",
      wrote: true,
      fallbackApplied: true,
      fallbackRate: 1.2,
    });
    expect(restoreProviderCostMultiplierMock).toHaveBeenCalledWith(
      7,
      1.2,
      new Date("2026-08-02T12:00:00.000Z")
    );
  });

  it("分组不在匿名倍率表 -> group_not_in_table，立即还原默认倍率", async () => {
    getNewapiRatioTableMock.mockResolvedValue({ ok: true, table: { default: 1 } });
    fetchNewapiTokenGroupMock.mockResolvedValue({ ok: true, group: "internal" });

    const outcome = await syncProviderUpstreamRate(
      makeProvider({ costMultiplier: 1.6, rateDefaultMultiplier: 1.2 })
    );

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "group_not_in_table",
      wrote: true,
      fallbackApplied: true,
      fallbackRate: 1.2,
    });
    expect(restoreProviderCostMultiplierMock).toHaveBeenCalledTimes(1);
  });

  it("分组倍率越界（<=0 或 >100）按 group_not_in_table 处理", async () => {
    getNewapiRatioTableMock.mockResolvedValue({ ok: true, table: { free: 0 } });
    fetchNewapiTokenGroupMock.mockResolvedValue({ ok: true, group: "free" });

    const outcome = await syncProviderUpstreamRate(makeProvider({ rateDefaultMultiplier: null }));

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "group_not_in_table",
      wrote: false,
    });
    expect(restoreProviderCostMultiplierMock).not.toHaveBeenCalled();
  });

  it("pricing 403（模块关闭）-> unsupported 语义，立即还原默认倍率", async () => {
    getNewapiRatioTableMock.mockResolvedValue({ ok: false, reason: "unsupported", status: 403 });

    const outcome = await syncProviderUpstreamRate(
      makeProvider({ costMultiplier: 1.6, rateDefaultMultiplier: 1.2 })
    );

    expect(outcome).toEqual({ status: "unsupported_restored", finalRate: 1.2, wrote: true });
    expect(fetchNewapiTokenGroupMock).toHaveBeenCalledTimes(1);
  });

  it("pricing 403 且当前已等于默认倍率 -> unsupported 不写库", async () => {
    getNewapiRatioTableMock.mockResolvedValue({ ok: false, reason: "unsupported", status: 403 });

    const outcome = await syncProviderUpstreamRate(
      makeProvider({ costMultiplier: 1.0, rateDefaultMultiplier: 1.0 })
    );

    expect(outcome).toEqual({ status: "unsupported", wrote: false });
    expect(restoreProviderCostMultiplierMock).not.toHaveBeenCalled();
  });

  it("倍率表拉取失败（http）按普通失败处理", async () => {
    getNewapiRatioTableMock.mockResolvedValue({
      ok: false,
      reason: "http",
      status: 500,
      error: "HTTP 500",
    });

    const outcome = await syncProviderUpstreamRate(makeProvider());

    expect(outcome).toMatchObject({ status: "failed", reason: "http", httpStatus: 500 });
    expect(fetchNewapiTokenGroupMock).toHaveBeenCalledTimes(1);
  });

  it("成功写回被 CAS 跳过 -> provider_changed", async () => {
    getNewapiRatioTableMock.mockResolvedValue({ ok: true, table: { default: 1 } });
    fetchNewapiTokenGroupMock.mockResolvedValue({ ok: true, group: "default" });
    updateUpstreamBillingProbeResultMock.mockResolvedValue(false);

    const outcome = await syncProviderUpstreamRate(makeProvider());

    expect(outcome).toEqual({ status: "failed", reason: "provider_changed", wrote: false });
  });
});
