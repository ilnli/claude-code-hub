"use server";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { messageRequest, usageAttemptLedger } from "@/drizzle/schema";
import { formatCostForStorage } from "@/lib/utils/currency";

export type ExplicitCompactionAttemptUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  reasoningTokens?: number;
};

export type CommitExplicitCompactionAttemptInput = {
  requestId: number;
  attemptOrdinal: number;
  providerId: number;
  providerEndpointId: number | null;
  model: string | null;
  compactionVersion: "v1" | "v2";
  usage: ExplicitCompactionAttemptUsage | null;
  usageSource: string | null;
  pricingEffectiveAt: Date | null;
  priceSource: string | null;
  priceSnapshot: Record<string, unknown> | null;
  costMultiplier: number;
  groupCostMultiplier: number;
  costUsd: string;
  pricingState: "not_applicable" | "committed" | "pricing_pending";
  validationOutcome: string;
  validationReason: string | null;
  responseBytes: number;
  transport: string;
  attemptedAt: Date;
  completedAt: Date;
};

function sameCommittedAttempt(
  existing: typeof usageAttemptLedger.$inferSelect,
  input: CommitExplicitCompactionAttemptInput
): boolean {
  return (
    existing.providerId === input.providerId &&
    existing.providerEndpointId === input.providerEndpointId &&
    existing.model === input.model &&
    existing.compactionVersion === input.compactionVersion &&
    existing.returnedUsage === (input.usage !== null) &&
    existing.usageSource === input.usageSource &&
    existing.inputTokens === (input.usage?.inputTokens ?? null) &&
    existing.outputTokens === (input.usage?.outputTokens ?? null) &&
    existing.cacheCreationInputTokens === (input.usage?.cacheCreationInputTokens ?? null) &&
    existing.cacheReadInputTokens === (input.usage?.cacheReadInputTokens ?? null) &&
    existing.cacheCreation5mInputTokens === (input.usage?.cacheCreation5mInputTokens ?? null) &&
    existing.cacheCreation1hInputTokens === (input.usage?.cacheCreation1hInputTokens ?? null) &&
    existing.reasoningTokens === (input.usage?.reasoningTokens ?? null) &&
    existing.pricingState === input.pricingState &&
    formatCostForStorage(existing.costUsd) === formatCostForStorage(input.costUsd) &&
    Number(existing.costMultiplier) === input.costMultiplier &&
    Number(existing.groupCostMultiplier) === input.groupCostMultiplier &&
    existing.validationOutcome === input.validationOutcome &&
    existing.validationReason === input.validationReason &&
    existing.responseBytes === input.responseBytes &&
    existing.transport === input.transport &&
    existing.attemptedAt.getTime() === input.attemptedAt.getTime() &&
    existing.completedAt.getTime() === input.completedAt.getTime()
  );
}

async function commitOnce(input: CommitExplicitCompactionAttemptInput): Promise<boolean> {
  const storedCost = formatCostForStorage(input.costUsd) ?? "0";
  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(usageAttemptLedger)
      .values({
        requestId: input.requestId,
        attemptOrdinal: input.attemptOrdinal,
        providerId: input.providerId,
        providerEndpointId: input.providerEndpointId,
        model: input.model,
        compactionVersion: input.compactionVersion,
        returnedUsage: input.usage !== null,
        usageSource: input.usageSource,
        inputTokens: input.usage?.inputTokens,
        outputTokens: input.usage?.outputTokens,
        cacheCreationInputTokens: input.usage?.cacheCreationInputTokens,
        cacheReadInputTokens: input.usage?.cacheReadInputTokens,
        cacheCreation5mInputTokens: input.usage?.cacheCreation5mInputTokens,
        cacheCreation1hInputTokens: input.usage?.cacheCreation1hInputTokens,
        reasoningTokens: input.usage?.reasoningTokens,
        pricingEffectiveAt: input.pricingEffectiveAt,
        priceSource: input.priceSource,
        priceSnapshot: input.priceSnapshot,
        costMultiplier: input.costMultiplier.toString(),
        groupCostMultiplier: input.groupCostMultiplier.toString(),
        costUsd: storedCost,
        pricingState: input.pricingState,
        validationOutcome: input.validationOutcome,
        validationReason: input.validationReason,
        responseBytes: input.responseBytes,
        transport: input.transport,
        attemptedAt: input.attemptedAt,
        completedAt: input.completedAt,
      })
      .onConflictDoNothing({
        target: [usageAttemptLedger.requestId, usageAttemptLedger.attemptOrdinal],
      })
      .returning({ id: usageAttemptLedger.id });

    if (inserted.length === 0) {
      const [existing] = await tx
        .select()
        .from(usageAttemptLedger)
        .where(
          and(
            eq(usageAttemptLedger.requestId, input.requestId),
            eq(usageAttemptLedger.attemptOrdinal, input.attemptOrdinal)
          )
        )
        .limit(1);
      if (!existing || !sameCommittedAttempt(existing, input)) {
        throw new Error("conflicting_explicit_compaction_attempt_commitment");
      }
    }

    const [aggregate] = await tx
      .select({
        costUsd: sql<string>`COALESCE(SUM(${usageAttemptLedger.costUsd}), 0)::text`,
        inputTokens: sql<number>`COALESCE(SUM(${usageAttemptLedger.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`COALESCE(SUM(${usageAttemptLedger.outputTokens}), 0)::bigint`,
        cacheCreationInputTokens: sql<number>`COALESCE(SUM(${usageAttemptLedger.cacheCreationInputTokens}), 0)::bigint`,
        cacheReadInputTokens: sql<number>`COALESCE(SUM(${usageAttemptLedger.cacheReadInputTokens}), 0)::bigint`,
        cacheCreation5mInputTokens: sql<number>`COALESCE(SUM(${usageAttemptLedger.cacheCreation5mInputTokens}), 0)::bigint`,
        cacheCreation1hInputTokens: sql<number>`COALESCE(SUM(${usageAttemptLedger.cacheCreation1hInputTokens}), 0)::bigint`,
      })
      .from(usageAttemptLedger)
      .where(eq(usageAttemptLedger.requestId, input.requestId));

    await tx
      .update(messageRequest)
      .set({
        costUsd: formatCostForStorage(aggregate?.costUsd) ?? "0",
        inputTokens: Number(aggregate?.inputTokens ?? 0),
        outputTokens: Number(aggregate?.outputTokens ?? 0),
        cacheCreationInputTokens: Number(aggregate?.cacheCreationInputTokens ?? 0),
        cacheReadInputTokens: Number(aggregate?.cacheReadInputTokens ?? 0),
        cacheCreation5mInputTokens: Number(aggregate?.cacheCreation5mInputTokens ?? 0),
        cacheCreation1hInputTokens: Number(aggregate?.cacheCreation1hInputTokens ?? 0),
        billingState: input.pricingState === "pricing_pending" ? "pricing_pending" : "in_progress",
        updatedAt: new Date(),
      })
      .where(eq(messageRequest.id, input.requestId));

    return inserted.length > 0;
  });
}

export async function commitExplicitCompactionAttempt(
  input: CommitExplicitCompactionAttemptInput
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await commitOnce(input);
    } catch (error) {
      lastError = error;
      if (
        error instanceof Error &&
        error.message === "conflicting_explicit_compaction_attempt_commitment"
      ) {
        throw error;
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export async function sealExplicitCompactionBilling(requestId: number): Promise<void> {
  await db
    .update(messageRequest)
    .set({ billingState: "sealed", updatedAt: new Date() })
    .where(and(eq(messageRequest.id, requestId), eq(messageRequest.billingState, "in_progress")));
}
