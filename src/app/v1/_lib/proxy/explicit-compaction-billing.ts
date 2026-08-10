import { logger } from "@/lib/logger";
import { RateLimitService } from "@/lib/rate-limit/service";
import { calculateRequestCost } from "@/lib/utils/cost-calculation";
import { commitExplicitCompactionAttempt } from "@/repository/usage-attempt-ledger";
import type { Provider } from "@/types/provider";
import type { ExplicitCompactionValidationResult } from "./explicit-compaction-response";
import { getExplicitCompactionVersionFromSession, type ProxySession } from "./session";

type NormalizedAttemptUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  reasoningTokens?: number;
};

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeAttemptUsage(usage: Record<string, unknown>): NormalizedAttemptUsage {
  const inputDetails = record(usage.input_tokens_details) ?? record(usage.prompt_tokens_details);
  const outputDetails =
    record(usage.output_tokens_details) ?? record(usage.completion_tokens_details);
  const cacheCreation = record(usage.cache_creation);
  return {
    inputTokens: nonNegativeNumber(usage.input_tokens) ?? nonNegativeNumber(usage.prompt_tokens),
    outputTokens:
      nonNegativeNumber(usage.output_tokens) ?? nonNegativeNumber(usage.completion_tokens),
    cacheCreationInputTokens: nonNegativeNumber(usage.cache_creation_input_tokens),
    cacheReadInputTokens:
      nonNegativeNumber(usage.cache_read_input_tokens) ??
      nonNegativeNumber(inputDetails?.cached_tokens),
    cacheCreation5mInputTokens:
      nonNegativeNumber(usage.cache_creation_5m_input_tokens) ??
      nonNegativeNumber(cacheCreation?.ephemeral_5m_input_tokens),
    cacheCreation1hInputTokens:
      nonNegativeNumber(usage.cache_creation_1h_input_tokens) ??
      nonNegativeNumber(cacheCreation?.ephemeral_1h_input_tokens),
    reasoningTokens: nonNegativeNumber(outputDetails?.reasoning_tokens),
  };
}

export class ExplicitCompactionBillingError extends Error {
  constructor(
    public readonly publicCode: "billing_persistence_unavailable" | "billing_pricing_unavailable"
  ) {
    super(publicCode);
    this.name = "ExplicitCompactionBillingError";
  }
}

export async function commitExplicitCompactionValidationAttempt(input: {
  session: ProxySession;
  provider: Provider;
  providerEndpointId: number | null;
  attemptOrdinal: number;
  attemptedAt: Date;
  completedAt: Date;
  validation: ExplicitCompactionValidationResult;
}): Promise<void> {
  const { session, provider, validation } = input;
  const requestId = session.messageContext?.id;
  const compactionVersion = getExplicitCompactionVersionFromSession(session);
  if (!requestId || !compactionVersion) {
    throw new ExplicitCompactionBillingError("billing_persistence_unavailable");
  }

  const normalizedUsage = validation.usage ? normalizeAttemptUsage(validation.usage) : null;
  let resolvedPricing: Awaited<ReturnType<ProxySession["getResolvedPricingByBillingSource"]>> =
    null;
  let costUsd = "0";
  let pricingState: "not_applicable" | "committed" | "pricing_pending" = "not_applicable";

  if (normalizedUsage) {
    try {
      resolvedPricing = await session.getResolvedPricingByBillingSource(provider, {
        originalModel: session.getOriginalModel(),
        redirectedModel: session.getCurrentModel(),
      });
    } catch (error) {
      logger.error("[ExplicitCompactionBilling] Failed to resolve attempt pricing", {
        requestId,
        attemptOrdinal: input.attemptOrdinal,
        providerId: provider.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!resolvedPricing?.priceData) {
      pricingState = "pricing_pending";
    } else {
      costUsd = calculateRequestCost(
        {
          input_tokens: normalizedUsage.inputTokens,
          output_tokens: normalizedUsage.outputTokens,
          cache_creation_input_tokens: normalizedUsage.cacheCreationInputTokens,
          cache_creation_5m_input_tokens: normalizedUsage.cacheCreation5mInputTokens,
          cache_creation_1h_input_tokens: normalizedUsage.cacheCreation1hInputTokens,
          cache_read_input_tokens: normalizedUsage.cacheReadInputTokens,
        },
        resolvedPricing.priceData,
        {
          multiplier: provider.costMultiplier,
          groupMultiplier: session.getGroupCostMultiplier(),
          context1mApplied: session.getContext1mApplied(),
          priorityServiceTierApplied:
            (session.request.message as Record<string, unknown>).service_tier === "priority",
        }
      ).toString();
      pricingState = "committed";
    }
  }

  let inserted = false;
  try {
    inserted = await commitExplicitCompactionAttempt({
      requestId,
      attemptOrdinal: input.attemptOrdinal,
      providerId: provider.id,
      providerEndpointId: input.providerEndpointId,
      model: session.getCurrentModel(),
      compactionVersion,
      usage: normalizedUsage,
      usageSource: validation.usage
        ? validation.evidence.transport === "sse"
          ? "response.completed"
          : "json.root.usage"
        : null,
      pricingEffectiveAt: normalizedUsage ? input.attemptedAt : null,
      priceSource: resolvedPricing?.source ?? null,
      priceSnapshot: resolvedPricing?.priceData
        ? (resolvedPricing.priceData as unknown as Record<string, unknown>)
        : null,
      costMultiplier: provider.costMultiplier,
      groupCostMultiplier: session.getGroupCostMultiplier(),
      costUsd,
      pricingState,
      validationOutcome: validation.outcome,
      validationReason: validation.reason ?? null,
      responseBytes: validation.evidence.responseBytes,
      transport: validation.evidence.transport,
      attemptedAt: input.attemptedAt,
      completedAt: input.completedAt,
    });
  } catch (error) {
    logger.error("[ExplicitCompactionBilling] Failed to commit attempt", {
      requestId,
      attemptOrdinal: input.attemptOrdinal,
      providerId: provider.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ExplicitCompactionBillingError("billing_persistence_unavailable");
  }

  if (pricingState === "pricing_pending") {
    throw new ExplicitCompactionBillingError("billing_pricing_unavailable");
  }

  if (inserted && normalizedUsage && Number(costUsd) > 0) {
    const key = session.authState?.key;
    const user = session.authState?.user;
    if (key && user) {
      try {
        const eventId = `${requestId}:compaction:${input.attemptOrdinal}`;
        await RateLimitService.trackCost(
          key.id,
          provider.id,
          session.sessionId ?? "",
          Number(costUsd),
          {
            userId: user.id,
            key5hResetMode: key.limit5hResetMode,
            keyResetTime: key.dailyResetTime,
            keyResetMode: key.dailyResetMode,
            provider5hResetMode: provider.limit5hResetMode,
            providerResetTime: provider.dailyResetTime,
            providerResetMode: provider.dailyResetMode,
            user5hResetMode: user.limit5hResetMode,
            userResetTime: user.dailyResetTime,
            userResetMode: user.dailyResetMode,
            requestId: eventId,
            createdAtMs: input.attemptedAt.getTime(),
          }
        );
        await RateLimitService.settleLeaseBudgets({
          requestId: eventId,
          cost: Number(costUsd),
          entities: {
            key: {
              id: key.id,
              resetModes: { "5h": key.limit5hResetMode, daily: key.dailyResetMode },
            },
            user: {
              id: user.id,
              resetModes: { "5h": user.limit5hResetMode, daily: user.dailyResetMode },
            },
            provider: {
              id: provider.id,
              resetModes: { "5h": provider.limit5hResetMode, daily: provider.dailyResetMode },
            },
          },
        });
      } catch (error) {
        logger.warn("[ExplicitCompactionBilling] Failed to update rate-limit counters", {
          requestId,
          attemptOrdinal: input.attemptOrdinal,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
