import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types/provider";

let acquireLeaderLockMock: ReturnType<typeof vi.fn>;
let renewLeaderLockMock: ReturnType<typeof vi.fn>;
let releaseLeaderLockMock: ReturnType<typeof vi.fn>;
let findFollowUpstreamProvidersMock: ReturnType<typeof vi.fn>;
let updateUpstreamBillingProbeResultMock: ReturnType<typeof vi.fn>;
let restoreProviderCostMultiplierMock: ReturnType<typeof vi.fn>;
let probeUpstreamBillingMock: ReturnType<typeof vi.fn>;
let getSettingsMock: ReturnType<typeof vi.fn>;
let publishInvalidationMock: ReturnType<typeof vi.fn>;
let sendFailureAlertMock: ReturnType<typeof vi.fn>;

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/provider-endpoints/leader-lock", () => ({
  acquireLeaderLock: (...args: unknown[]) => acquireLeaderLockMock(...args),
  renewLeaderLock: (...args: unknown[]) => renewLeaderLockMock(...args),
  releaseLeaderLock: (...args: unknown[]) => releaseLeaderLockMock(...args),
  startLeaderLockKeepAlive: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("@/lib/cache/provider-cache", () => ({
  publishProviderCacheInvalidation: (...args: unknown[]) => publishInvalidationMock(...args),
}));

vi.mock("@/lib/notification/notifier", () => ({
  sendUpstreamBillingProbeFailureAlert: (...args: unknown[]) => sendFailureAlertMock(...args),
}));

vi.mock("@/lib/system-settings/upstream-billing-probe", () => ({
  getUpstreamBillingProbeSettings: (...args: unknown[]) => getSettingsMock(...args),
}));

vi.mock("@/lib/upstream-billing/client", () => ({
  probeUpstreamBilling: (...args: unknown[]) => probeUpstreamBillingMock(...args),
}));

vi.mock("@/repository", () => ({
  findFollowUpstreamProviders: (...args: unknown[]) => findFollowUpstreamProvidersMock(...args),
  updateUpstreamBillingProbeResult: (...args: unknown[]) =>
    updateUpstreamBillingProbeResultMock(...args),
  restoreProviderCostMultiplier: (...args: unknown[]) => restoreProviderCostMultiplierMock(...args),
}));

import {
  getUpstreamBillingProbeSchedulerStatus,
  startUpstreamBillingProbeScheduler,
  stopUpstreamBillingProbeScheduler,
  syncAndTrackProviderUpstreamRate,
} from "@/lib/upstream-billing/probe-scheduler";

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
    upstreamRateMultiplier: null,
    upstreamRateSyncedAt: null,
    isEnabled: true,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    updatedAt: new Date("2026-08-02T12:00:00.000Z"),
    ...overrides,
  } as Provider;
}

async function waitForCurrentCycle(): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    await Promise.resolve();
    if (!getUpstreamBillingProbeSchedulerStatus().running) {
      return;
    }
  }
  throw new Error("upstream billing probe cycle did not finish");
}

/** 停止再启动调度器，手动触发新一轮探测周期 */
async function runNextCycle(): Promise<void> {
  await stopUpstreamBillingProbeScheduler();
  startUpstreamBillingProbeScheduler();
  await waitForCurrentCycle();
}

describe("upstream-billing probe-scheduler", () => {
  beforeEach(() => {
    acquireLeaderLockMock = vi.fn().mockResolvedValue({ key: "k", lockId: "lock-1" });
    renewLeaderLockMock = vi.fn().mockResolvedValue(true);
    releaseLeaderLockMock = vi.fn().mockResolvedValue(undefined);
    findFollowUpstreamProvidersMock = vi.fn().mockResolvedValue([]);
    updateUpstreamBillingProbeResultMock = vi.fn().mockResolvedValue(true);
    restoreProviderCostMultiplierMock = vi.fn().mockResolvedValue(true);
    probeUpstreamBillingMock = vi.fn();
    getSettingsMock = vi.fn().mockResolvedValue({ enabled: true, intervalMinutes: 30 });
    publishInvalidationMock = vi.fn().mockResolvedValue(undefined);
    sendFailureAlertMock = vi.fn().mockResolvedValue(undefined);

    // 清空 globalThis 上的调度器内存态
    const state = globalThis as Record<string, unknown>;
    state.__CCH_UPSTREAM_BILLING_PROBE_MEMORY__ = undefined;
    state.__CCH_UPSTREAM_BILLING_PROBE_QUEUE__ = undefined;
    state.__CCH_UPSTREAM_BILLING_PROBE_QUEUED_IDS__ = undefined;
  });

  afterEach(async () => {
    await stopUpstreamBillingProbeScheduler();
  });

  it("idles when globally disabled", async () => {
    getSettingsMock.mockResolvedValue({ enabled: false, intervalMinutes: 30 });

    startUpstreamBillingProbeScheduler();
    await waitForCurrentCycle();

    expect(findFollowUpstreamProvidersMock).not.toHaveBeenCalled();
    expect(probeUpstreamBillingMock).not.toHaveBeenCalled();
  });

  it("writes back marked-up rate on successful probe", async () => {
    findFollowUpstreamProvidersMock.mockResolvedValue([
      makeProvider({ rateMarkupType: "percent", rateMarkupValue: 0.1 }),
    ]);
    probeUpstreamBillingMock.mockResolvedValue({ ok: true, rate: 1.6 });

    startUpstreamBillingProbeScheduler();
    await waitForCurrentCycle();

    expect(updateUpstreamBillingProbeResultMock).toHaveBeenCalledWith(
      1,
      {
        costMultiplier: 1.76, // 1.6 * 1.1
        upstreamRateMultiplier: 1.6,
        syncedAt: expect.any(Date),
      },
      new Date("2026-08-02T12:00:00.000Z")
    );
    expect(publishInvalidationMock).toHaveBeenCalled();
  });

  it("applies fixed markup (+0.01)", async () => {
    findFollowUpstreamProvidersMock.mockResolvedValue([
      makeProvider({ rateMarkupType: "fixed", rateMarkupValue: 0.01 }),
    ]);
    probeUpstreamBillingMock.mockResolvedValue({ ok: true, rate: 1.0 });

    startUpstreamBillingProbeScheduler();
    await waitForCurrentCycle();

    expect(updateUpstreamBillingProbeResultMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ costMultiplier: 1.01 }),
      new Date("2026-08-02T12:00:00.000Z")
    );
  });

  it("does not write anything on probe failure and backs off", async () => {
    findFollowUpstreamProvidersMock.mockResolvedValue([makeProvider()]);
    probeUpstreamBillingMock.mockResolvedValue({ ok: false, reason: "network", error: "boom" });

    startUpstreamBillingProbeScheduler();
    await waitForCurrentCycle();

    expect(updateUpstreamBillingProbeResultMock).not.toHaveBeenCalled();
    expect(restoreProviderCostMultiplierMock).not.toHaveBeenCalled();
    expect(publishInvalidationMock).not.toHaveBeenCalled();

    // 失败后进入退避：紧接着的下一个周期不再探测该 provider
    await runNextCycle();
    expect(probeUpstreamBillingMock).toHaveBeenCalledTimes(1);
  });

  it("restores default rate when upstream is unsupported", async () => {
    findFollowUpstreamProvidersMock.mockResolvedValue([
      makeProvider({ costMultiplier: 1.77, rateDefaultMultiplier: 1.2 }),
    ]);
    probeUpstreamBillingMock.mockResolvedValue({ ok: false, reason: "unsupported", status: 404 });

    startUpstreamBillingProbeScheduler();
    await waitForCurrentCycle();

    expect(restoreProviderCostMultiplierMock).toHaveBeenCalledWith(
      1,
      1.2,
      new Date("2026-08-02T12:00:00.000Z")
    );
    expect(publishInvalidationMock).toHaveBeenCalled();

    // unsupported 标记后固定 8 倍间隔降频：下一周期不再探测
    await runNextCycle();
    expect(probeUpstreamBillingMock).toHaveBeenCalledTimes(1);
  });

  it("skips restore when current rate already equals default", async () => {
    findFollowUpstreamProvidersMock.mockResolvedValue([
      makeProvider({ costMultiplier: 1.0, rateDefaultMultiplier: 1.0 }),
    ]);
    probeUpstreamBillingMock.mockResolvedValue({ ok: false, reason: "unsupported", status: 404 });

    startUpstreamBillingProbeScheduler();
    await waitForCurrentCycle();

    expect(restoreProviderCostMultiplierMock).not.toHaveBeenCalled();
  });

  it("probes again after a successful sync once due", async () => {
    findFollowUpstreamProvidersMock.mockResolvedValue([makeProvider()]);
    probeUpstreamBillingMock.mockResolvedValue({ ok: true, rate: 1.0 });

    startUpstreamBillingProbeScheduler();
    await waitForCurrentCycle();
    expect(probeUpstreamBillingMock).toHaveBeenCalledTimes(1);

    // 成功探测后未到期间隔：下一周期跳过
    await runNextCycle();
    expect(probeUpstreamBillingMock).toHaveBeenCalledTimes(1);
  });

  it("probes ALL due providers in one cycle without starvation cap", async () => {
    // 25 个 provider 全部到期（无内存记录），同一周期内必须全部探测，不得切片
    const providers = Array.from({ length: 25 }, (_, i) =>
      makeProvider({ id: i + 1, name: `p${i + 1}` })
    );
    findFollowUpstreamProvidersMock.mockResolvedValue(providers);
    probeUpstreamBillingMock.mockResolvedValue({ ok: true, rate: 1.0 });

    startUpstreamBillingProbeScheduler();
    await waitForCurrentCycle();

    expect(probeUpstreamBillingMock).toHaveBeenCalledTimes(25);
    expect(updateUpstreamBillingProbeResultMock).toHaveBeenCalledTimes(25);
  });

  it("deduplicates providers already present in the probe queue", async () => {
    const provider = makeProvider({ id: 31 });
    findFollowUpstreamProvidersMock.mockResolvedValue([provider, { ...provider }]);
    probeUpstreamBillingMock.mockResolvedValue({ ok: true, rate: 1.0 });

    startUpstreamBillingProbeScheduler();
    await waitForCurrentCycle();

    expect(probeUpstreamBillingMock).toHaveBeenCalledTimes(1);
    expect(updateUpstreamBillingProbeResultMock).toHaveBeenCalledTimes(1);
    expect(getUpstreamBillingProbeSchedulerStatus().queuedProviders).toBe(0);
  });

  it("notifies on every failure and falls back on the third consecutive failure", async () => {
    const provider = makeProvider({
      id: 41,
      costMultiplier: 1.6,
      rateDefaultMultiplier: 1.2,
      upstreamRateMultiplier: 1.6,
    });
    probeUpstreamBillingMock.mockResolvedValue({
      ok: false,
      reason: "invalid",
      error: "missing resolved_rate_multiplier",
    });

    await syncAndTrackProviderUpstreamRate(provider);
    await syncAndTrackProviderUpstreamRate(provider);
    const third = await syncAndTrackProviderUpstreamRate(provider);

    expect(sendFailureAlertMock).toHaveBeenCalledTimes(3);
    expect(sendFailureAlertMock.mock.calls.map((call) => call[0]?.failureCount)).toEqual([1, 2, 3]);
    expect(restoreProviderCostMultiplierMock).toHaveBeenCalledTimes(1);
    expect(third).toMatchObject({ status: "failed", fallbackApplied: true, wrote: true });
    expect(sendFailureAlertMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerId: 41,
        failureCount: 3,
        fallbackApplied: true,
        fallbackRate: 1.2,
      })
    );
  });
});
