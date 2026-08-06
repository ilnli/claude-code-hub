import { publishProviderCacheInvalidation } from "@/lib/cache/provider-cache";
import { logger } from "@/lib/logger";
import {
  calculateProviderWeightAdjustment,
  type WeightAdjustmentPreviewRow,
} from "@/lib/provider-weight-adjustment/calculation";
import {
  claimProviderWeightAdjustmentRun,
  clearProviderWeightAdjustmentFault,
  completeProviderWeightAdjustmentRun,
  failProviderWeightAdjustmentRun,
  findProviderWeightAdjustmentRunByIdempotencyKey,
  getProviderWeightAdjustmentPreview,
  getProviderWeightAdjustmentRun,
  loadProviderWeightAdjustmentRunSnapshot,
  markProviderWeightAdjustmentRunWarning,
  ProviderWeightAdjustmentError,
  setProviderWeightAdjustmentFault,
} from "@/repository/provider-weight-adjustment";
import type {
  ProviderWeightAdjustmentFaultKind,
  ProviderWeightAdjustmentRun,
  ProviderWeightAdjustmentRunSummary,
  ProviderWeightAdjustmentTrigger,
} from "@/types/provider-weight-adjustment";
import { sendProviderWeightAdjustmentAlert } from "./notifications";

export interface ExecuteProviderWeightAdjustmentOptions {
  ruleId: number;
  trigger: ProviderWeightAdjustmentTrigger;
  idempotencyKey?: string;
  requestedAt?: Date;
}

function detailFromRow(
  row: WeightAdjustmentPreviewRow,
  outcome: "changed" | "skipped" | "failed",
  reason?: string | null
) {
  return {
    providerId: row.providerId,
    providerName: row.providerName,
    outcome,
    costMultiplier: row.parsedCostMultiplier,
    previousWeight: row.currentWeight,
    projectedWeight: row.projectedWeight,
    reason: reason ?? row.skipReason,
  };
}

async function openFaultEpisode(input: {
  ruleId: number;
  ruleName: string;
  kind: ProviderWeightAdjustmentFaultKind;
  message: string;
  runId?: number;
}): Promise<void> {
  const opened = await setProviderWeightAdjustmentFault(input.ruleId, {
    kind: input.kind,
    message: input.message,
  });
  if (!opened) return;
  await sendProviderWeightAdjustmentAlert({
    event: "fault",
    ruleId: input.ruleId,
    ruleName: input.ruleName,
    runId: input.runId,
    faultKind: input.kind,
    message: input.message,
    generatedAt: new Date().toISOString(),
  });
}

async function recoverFaultEpisode(input: {
  ruleId: number;
  ruleName: string;
  runId: number;
}): Promise<void> {
  const recovered = await clearProviderWeightAdjustmentFault(input.ruleId);
  if (!recovered) return;
  await sendProviderWeightAdjustmentAlert({
    event: "recovery",
    ruleId: input.ruleId,
    ruleName: input.ruleName,
    runId: input.runId,
    generatedAt: new Date().toISOString(),
  });
}

export async function executeProviderWeightAdjustment(
  options: ExecuteProviderWeightAdjustmentOptions
): Promise<ProviderWeightAdjustmentRun> {
  if (options.trigger === "manual") {
    const idempotencyKey = options.idempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new ProviderWeightAdjustmentError(
        "idempotency_key_required",
        "Manual execution requires an idempotency key."
      );
    }
    const replay = await findProviderWeightAdjustmentRunByIdempotencyKey(
      options.ruleId,
      idempotencyKey
    );
    if (replay) return replay;

    const current = await getProviderWeightAdjustmentPreview(options.ruleId);
    if (!current) {
      throw new ProviderWeightAdjustmentError("rule_not_found", "Rule not found.");
    }
    if (!current.preview.actionable) {
      throw new ProviderWeightAdjustmentError(
        "insufficient_participants",
        "At least two valid participants are required to run this rule."
      );
    }
  }

  const claim = await claimProviderWeightAdjustmentRun({
    ruleId: options.ruleId,
    trigger: options.trigger,
    idempotencyKey: options.idempotencyKey?.trim() || null,
    requestedAt: options.requestedAt,
  });
  if (claim.replay) return claim.run;

  const snapshot = await loadProviderWeightAdjustmentRunSnapshot(options.ruleId);
  if (!snapshot) {
    const message = "The rule was deleted after the run was accepted.";
    await failProviderWeightAdjustmentRun(claim.run.id, options.ruleId, message);
    throw new ProviderWeightAdjustmentError("rule_not_found", message);
  }

  const preview = calculateProviderWeightAdjustment(
    { providerType: snapshot.rule.providerType, priority: snapshot.rule.priority },
    snapshot.members
  );
  if (!preview.actionable) {
    const summary: ProviderWeightAdjustmentRunSummary = {
      memberCount: preview.memberCount,
      participantCount: preview.participantCount,
      changedCount: 0,
      skippedCount: preview.memberCount,
      failedCount: 0,
    };
    const message = "The rule has fewer than two valid participants.";
    await completeProviderWeightAdjustmentRun({
      runId: claim.run.id,
      ruleId: options.ruleId,
      expectedRevision: claim.run.ruleRevision,
      status: "skipped",
      summary,
      changes: [],
      details: preview.rows.map((row) => detailFromRow(row, "skipped", row.skipReason)),
      errorMessage: message,
    });
    await openFaultEpisode({
      ruleId: options.ruleId,
      ruleName: claim.run.ruleName,
      runId: claim.run.id,
      kind: "insufficient_participants",
      message,
    });
    return (await getProviderWeightAdjustmentRun(claim.run.id))!;
  }

  const changedRows = preview.rows.filter(
    (row) => row.projectedWeight !== null && row.projectedWeight !== row.currentWeight
  );
  const skippedRows = preview.rows.filter((row) => !row.participates);
  const summary: ProviderWeightAdjustmentRunSummary = {
    memberCount: preview.memberCount,
    participantCount: preview.participantCount,
    changedCount: changedRows.length,
    skippedCount: skippedRows.length,
    failedCount: 0,
  };

  try {
    await completeProviderWeightAdjustmentRun({
      runId: claim.run.id,
      ruleId: options.ruleId,
      expectedRevision: claim.run.ruleRevision,
      status: "succeeded",
      summary,
      changes: changedRows.map((row) => ({
        providerId: row.providerId,
        previousWeight: row.currentWeight,
        nextWeight: row.projectedWeight!,
        costMultiplier: row.parsedCostMultiplier!,
        providerType: row.providerType,
        priority: row.priority,
        isEnabled: row.isEnabled,
      })),
      details: [
        ...changedRows.map((row) => detailFromRow(row, "changed")),
        ...skippedRows.map((row) => detailFromRow(row, "skipped")),
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedSummary = { ...summary, changedCount: 0, failedCount: changedRows.length };
    await failProviderWeightAdjustmentRun(
      claim.run.id,
      options.ruleId,
      message,
      new Date(),
      changedRows.map((row) => detailFromRow(row, "failed", message)),
      failedSummary
    );
    await openFaultEpisode({
      ruleId: options.ruleId,
      ruleName: claim.run.ruleName,
      runId: claim.run.id,
      kind: "run_failed",
      message,
    });
    logger.warn("[ProviderWeightAdjustment] run failed", {
      ruleId: options.ruleId,
      runId: claim.run.id,
      summary: failedSummary,
      error: message,
    });
    return (await getProviderWeightAdjustmentRun(claim.run.id))!;
  }

  if (changedRows.length > 0) {
    try {
      await publishProviderCacheInvalidation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markProviderWeightAdjustmentRunWarning(claim.run.id, message);
      await openFaultEpisode({
        ruleId: options.ruleId,
        ruleName: claim.run.ruleName,
        runId: claim.run.id,
        kind: "cache_invalidation_failed",
        message,
      });
      return (await getProviderWeightAdjustmentRun(claim.run.id))!;
    }
  }

  await recoverFaultEpisode({
    ruleId: options.ruleId,
    ruleName: claim.run.ruleName,
    runId: claim.run.id,
  });
  return (await getProviderWeightAdjustmentRun(claim.run.id))!;
}

export async function recordProviderWeightAdjustmentSchedulerFault(input: {
  ruleId: number;
  ruleName: string;
  kind: "coordination_failed" | "scheduler_failed" | "overlap";
  message: string;
}): Promise<void> {
  await openFaultEpisode(input);
}
