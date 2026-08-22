import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types/provider";

let probeUpstreamBillingMock: ReturnType<typeof vi.fn>;
let updateUpstreamBillingProbeResultMock: ReturnType<typeof vi.fn>;
let restoreProviderCostMultiplierMock: ReturnType<typeof vi.fn>;

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/upstream-billing/client", () => ({
  probeUpstreamBilling: (...args: unknown[]) => probeUpstreamBillingMock(...args),
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
    updatedAt: new Date("2026-08-02T12:00:00.000Z"),
    ...overrides,
  } as Provider;
}

describe("syncProviderUpstreamRate", () => {
  beforeEach(() => {
    probeUpstreamBillingMock = vi.fn();
    updateUpstreamBillingProbeResultMock = vi.fn().mockResolvedValue(true);
    restoreProviderCostMultiplierMock = vi.fn().mockResolvedValue(true);
  });

  it("writes back marked-up rate on success (percent)", async () => {
    probeUpstreamBillingMock.mockResolvedValue({ ok: true, rate: 1.6 });
    const outcome = await syncProviderUpstreamRate(
      makeProvider({ rateMarkupType: "percent", rateMarkupValue: 0.1 })
    );

    expect(outcome).toEqual({
      status: "synced",
      upstreamRate: 1.6,
      finalRate: 1.76,
      wrote: true,
    });
    expect(updateUpstreamBillingProbeResultMock).toHaveBeenCalledWith(
      7,
      {
        costMultiplier: 1.76,
        upstreamRateMultiplier: 1.6,
        syncedAt: expect.any(Date),
      },
      new Date("2026-08-02T12:00:00.000Z")
    );
  });

  it("restores default rate when unsupported and current differs", async () => {
    probeUpstreamBillingMock.mockResolvedValue({ ok: false, reason: "unsupported", status: 404 });
    const outcome = await syncProviderUpstreamRate(
      makeProvider({ costMultiplier: 1.77, rateDefaultMultiplier: 1.2 })
    );

    expect(outcome).toEqual({ status: "unsupported_restored", finalRate: 1.2, wrote: true });
    expect(restoreProviderCostMultiplierMock).toHaveBeenCalledWith(
      7,
      1.2,
      new Date("2026-08-02T12:00:00.000Z")
    );
  });

  it("does not report a stale successful probe as written", async () => {
    probeUpstreamBillingMock.mockResolvedValue({ ok: true, rate: 1.6 });
    updateUpstreamBillingProbeResultMock.mockResolvedValue(false);

    const outcome = await syncProviderUpstreamRate(makeProvider());

    expect(outcome).toEqual({ status: "failed", reason: "provider_changed", wrote: false });
  });

  it("does not report a stale fallback restore as written", async () => {
    probeUpstreamBillingMock.mockResolvedValue({ ok: false, reason: "unsupported", status: 404 });
    restoreProviderCostMultiplierMock.mockResolvedValue(false);

    const outcome = await syncProviderUpstreamRate(
      makeProvider({ costMultiplier: 1.77, rateDefaultMultiplier: 1.2 })
    );

    expect(outcome).toEqual({ status: "failed", reason: "provider_changed", wrote: false });
  });

  it("does not write when unsupported and already at default", async () => {
    probeUpstreamBillingMock.mockResolvedValue({ ok: false, reason: "unsupported", status: 404 });
    const outcome = await syncProviderUpstreamRate(
      makeProvider({ costMultiplier: 1.2, rateDefaultMultiplier: 1.2 })
    );

    expect(outcome).toEqual({ status: "unsupported", wrote: false });
    expect(restoreProviderCostMultiplierMock).not.toHaveBeenCalled();
  });

  it("reports failure without writing on probe error", async () => {
    probeUpstreamBillingMock.mockResolvedValue({ ok: false, reason: "timeout", error: "boom" });
    const outcome = await syncProviderUpstreamRate(makeProvider());

    expect(outcome).toMatchObject({ status: "failed", reason: "timeout", wrote: false });
    expect(updateUpstreamBillingProbeResultMock).not.toHaveBeenCalled();
    expect(restoreProviderCostMultiplierMock).not.toHaveBeenCalled();
  });

  it("preserves Cloudflare edge diagnostics in the sync outcome", async () => {
    probeUpstreamBillingMock.mockResolvedValue({
      ok: false,
      reason: "edge_blocked",
      error: "Cloudflare edge blocked or challenged the probe (HTTP 503, CF-Ray ray-sync)",
      status: 503,
      edgeProvider: "cloudflare",
      requestId: "ray-sync",
    });

    const outcome = await syncProviderUpstreamRate(makeProvider());

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "edge_blocked",
      httpStatus: 503,
      edgeProvider: "cloudflare",
      requestId: "ray-sync",
      wrote: false,
    });
  });

  it("keeps the last synced rate for two failures and restores default on the third", async () => {
    probeUpstreamBillingMock.mockResolvedValue({
      ok: false,
      reason: "invalid",
      error: "missing resolved_rate_multiplier",
    });
    const provider = makeProvider({
      costMultiplier: 1.6,
      rateDefaultMultiplier: 1.2,
      upstreamRateMultiplier: 1.6,
    });

    const first = await syncProviderUpstreamRate(provider, { consecutiveFailureCount: 1 });
    const second = await syncProviderUpstreamRate(provider, { consecutiveFailureCount: 2 });
    const third = await syncProviderUpstreamRate(provider, { consecutiveFailureCount: 3 });

    expect(first).toMatchObject({ status: "failed", wrote: false });
    expect(second).toMatchObject({ status: "failed", wrote: false });
    expect(restoreProviderCostMultiplierMock).toHaveBeenCalledTimes(1);
    expect(restoreProviderCostMultiplierMock).toHaveBeenCalledWith(
      7,
      1.2,
      new Date("2026-08-02T12:00:00.000Z")
    );
    expect(third).toMatchObject({
      status: "failed",
      wrote: true,
      fallbackApplied: true,
      fallbackRate: 1.2,
      fallbackCause: "failure_threshold",
    });
  });
});
