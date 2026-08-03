import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types/provider";

let getSessionMock: ReturnType<typeof vi.fn>;
let findProviderByIdMock: ReturnType<typeof vi.fn>;
let syncAndTrackProviderUpstreamRateMock: ReturnType<typeof vi.fn>;
let publishInvalidationMock: ReturnType<typeof vi.fn>;

vi.mock("@/lib/auth", () => ({
  getSession: () => getSessionMock(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/upstream-billing/probe-scheduler", () => ({
  syncAndTrackProviderUpstreamRate: (...args: unknown[]) =>
    syncAndTrackProviderUpstreamRateMock(...args),
}));

vi.mock("@/lib/cache/provider-cache", () => ({
  publishProviderCacheInvalidation: (...args: unknown[]) => publishInvalidationMock(...args),
}));

vi.mock("@/repository", () => ({
  findProviderById: (...args: unknown[]) => findProviderByIdMock(...args),
}));

import {
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
