import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calculateRequestCost: vi.fn(() => ({ toString: () => "0.125" })),
  commitAttempt: vi.fn(async () => true),
  settleLeaseBudgets: vi.fn(async () => undefined),
  trackCost: vi.fn(async () => undefined),
  checkTotalCostLimit: vi.fn(async () => ({ allowed: true })),
  checkCostLimitsWithLease: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/utils/cost-calculation", () => ({
  calculateRequestCost: mocks.calculateRequestCost,
}));

vi.mock("@/repository/usage-attempt-ledger", () => ({
  commitExplicitCompactionAttempt: mocks.commitAttempt,
}));

vi.mock("@/lib/rate-limit/service", () => ({
  RateLimitService: {
    settleLeaseBudgets: mocks.settleLeaseBudgets,
    trackCost: mocks.trackCost,
    checkTotalCostLimit: mocks.checkTotalCostLimit,
    checkCostLimitsWithLease: mocks.checkCostLimitsWithLease,
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

import {
  commitExplicitCompactionValidationAttempt,
  ExplicitCompactionBillingError,
} from "@/app/v1/_lib/proxy/explicit-compaction-billing";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

function createProvider(): Provider {
  return {
    id: 7,
    name: "provider-7",
    providerType: "codex",
    costMultiplier: 1.5,
  } as Provider;
}

function createSession(resolvedPricing: unknown): ProxySession {
  return {
    messageContext: { id: 81 },
    request: { message: { service_tier: "priority" } },
    getExplicitCompactionVersion: () => "v2",
    getResolvedPricingByBillingSource: vi.fn(async () => resolvedPricing),
    getOriginalModel: () => "gpt-original",
    getCurrentModel: () => "gpt-routed",
    getGroupCostMultiplier: () => 2,
    getContext1mApplied: () => false,
    authState: {
      key: { id: 3 },
      user: { id: 4 },
    },
    sessionId: "session-81",
  } as unknown as ProxySession;
}

function validation(usage: Record<string, unknown> | null) {
  return {
    outcome: "invalid" as const,
    reason: "missing_compaction_output" as const,
    usage,
    evidence: {
      transport: "json" as const,
      version: "v2" as const,
      responseBytes: 123,
      terminalSeen: true,
      compactionItemCount: 0,
      sourceCount: 1,
    },
  };
}

describe("explicit compaction attempt billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.commitAttempt.mockResolvedValue(true);
    mocks.checkTotalCostLimit.mockResolvedValue({ allowed: true });
    mocks.checkCostLimitsWithLease.mockResolvedValue({ allowed: true });
  });

  it("normalizes returned usage and commits the attempt before retry", async () => {
    const session = createSession({
      source: "provider_model",
      priceData: { input_cost_per_token: 0.001 },
    });
    const attemptedAt = new Date("2026-08-10T01:00:00.000Z");
    const completedAt = new Date("2026-08-10T01:00:01.000Z");

    await commitExplicitCompactionValidationAttempt({
      session,
      provider: createProvider(),
      providerEndpointId: 701,
      attemptOrdinal: 2,
      attemptedAt,
      completedAt,
      validation: validation({
        input_tokens: 20,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens_details: { reasoning_tokens: 3 },
      }),
    });

    expect(mocks.calculateRequestCost).toHaveBeenCalledWith(
      expect.objectContaining({
        input_tokens: 12,
        output_tokens: 5,
        cache_read_input_tokens: 8,
      }),
      expect.any(Object),
      expect.objectContaining({ multiplier: 1.5, groupMultiplier: 2 })
    );
    expect(mocks.commitAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 81,
        attemptOrdinal: 2,
        providerId: 7,
        providerEndpointId: 701,
        usage: expect.objectContaining({
          inputTokens: 12,
          outputTokens: 5,
          cacheReadInputTokens: 8,
          reasoningTokens: 3,
        }),
        costUsd: "0.125",
        pricingState: "committed",
        validationOutcome: "invalid",
        attemptedAt,
        completedAt,
      })
    );
  });

  it("writes a zero-cost evidence row when upstream returned no usage", async () => {
    const session = createSession(null);

    await commitExplicitCompactionValidationAttempt({
      session,
      provider: createProvider(),
      providerEndpointId: null,
      attemptOrdinal: 1,
      attemptedAt: new Date(),
      completedAt: new Date(),
      validation: validation(null),
    });

    expect(session.getResolvedPricingByBillingSource).not.toHaveBeenCalled();
    expect(mocks.calculateRequestCost).not.toHaveBeenCalled();
    expect(mocks.commitAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: null,
        costUsd: "0",
        pricingState: "not_applicable",
      })
    );
  });

  it("updates rate-limit counters only for the first durable attempt insert", async () => {
    const session = createSession({
      source: "provider_model",
      priceData: { input_cost_per_token: 0.001 },
    });
    const attemptedAt = new Date("2026-08-10T01:00:00.000Z");
    const completedAt = new Date("2026-08-10T01:00:01.000Z");
    const input = {
      session,
      provider: createProvider(),
      providerEndpointId: 701,
      attemptOrdinal: 2,
      attemptedAt,
      completedAt,
      validation: validation({ input_tokens: 20, output_tokens: 5 }),
    };
    mocks.commitAttempt.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await commitExplicitCompactionValidationAttempt(input);
    await commitExplicitCompactionValidationAttempt(input);

    expect(mocks.trackCost).toHaveBeenCalledTimes(1);
    expect(mocks.trackCost).toHaveBeenCalledWith(
      3,
      7,
      "session-81",
      0.125,
      expect.objectContaining({
        userId: 4,
        requestId: "81:compaction:2",
        createdAtMs: attemptedAt.getTime(),
      })
    );
    expect(mocks.settleLeaseBudgets).toHaveBeenCalledTimes(1);
    expect(mocks.settleLeaseBudgets).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "81:compaction:2", cost: 0.125 })
    );
  });

  it("persists pricing_pending usage and withholds the response", async () => {
    const session = createSession(null);

    await expect(
      commitExplicitCompactionValidationAttempt({
        session,
        provider: createProvider(),
        providerEndpointId: null,
        attemptOrdinal: 1,
        attemptedAt: new Date(),
        completedAt: new Date(),
        validation: validation({ input_tokens: 10 }),
      })
    ).rejects.toEqual(new ExplicitCompactionBillingError("billing_pricing_unavailable"));

    expect(mocks.commitAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ inputTokens: 10 }),
        pricingState: "pricing_pending",
      })
    );
  });

  it("stops another attempt when the charged attempt exhausts a budget", async () => {
    const session = createSession({
      source: "provider_model",
      priceData: { input_cost_per_token: 0.001 },
    });
    mocks.checkCostLimitsWithLease.mockResolvedValueOnce({ allowed: false });

    await expect(
      commitExplicitCompactionValidationAttempt({
        session,
        provider: createProvider(),
        providerEndpointId: 701,
        attemptOrdinal: 1,
        attemptedAt: new Date(),
        completedAt: new Date(),
        validation: validation({ input_tokens: 10 }),
      })
    ).rejects.toMatchObject({ name: "ExplicitCompactionQuotaError" });
    expect(mocks.commitAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.trackCost).toHaveBeenCalledTimes(1);
  });
});
