"use server";

import { emitActionAudit } from "@/lib/audit/emit";
import { getSession } from "@/lib/auth";
import { invalidateSystemSettingsCache } from "@/lib/config";
import { executeProviderWeightAdjustment } from "@/lib/provider-weight-adjustment/executor";
import * as repository from "@/repository/provider-weight-adjustment";
import type { ProviderType } from "@/types/provider";
import {
  PROVIDER_WEIGHT_ADJUSTMENT_INTERVALS,
  type ProviderWeightAdjustmentIntervalMinutes,
  type ProviderWeightAdjustmentRule,
  type ProviderWeightAdjustmentRun,
  type ProviderWeightAdjustmentRunDetail,
} from "@/types/provider-weight-adjustment";
import type { ActionResult } from "./types";

function failure(error: unknown): Extract<ActionResult<never>, { ok: false }> {
  if (error instanceof repository.ProviderWeightAdjustmentError) {
    return { ok: false, error: error.message, errorCode: error.code };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("uq_provider_weight_adjustment_rules_active_name")) {
    return { ok: false, error: "Rule name already exists.", errorCode: "rule_name_conflict" };
  }
  if (message.includes("uq_provider_weight_adjustment_rule_members_provider")) {
    return {
      ok: false,
      error: "A provider already belongs to another rule.",
      errorCode: "provider_already_managed",
    };
  }
  return { ok: false, error: message, errorCode: "operation_failed" };
}

async function requireAdmin(): Promise<boolean> {
  const session = await getSession();
  return session?.user.role === "admin";
}

async function buildRuleView(rule: ProviderWeightAdjustmentRule) {
  const loaded = await repository.getProviderWeightAdjustmentPreview(rule.id);
  return {
    ...rule,
    preview: loaded?.preview ?? {
      rows: [],
      memberCount: 0,
      participantCount: 0,
      changedCount: 0,
      skippedCount: 0,
      actionable: false,
    },
  };
}

export async function listProviderWeightAdjustmentRulesAction(): Promise<
  ActionResult<Awaited<ReturnType<typeof buildRuleView>>[]>
> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    const rules = await repository.listProviderWeightAdjustmentRules();
    return { ok: true, data: await Promise.all(rules.map(buildRuleView)) };
  } catch (error) {
    return failure(error);
  }
}

export async function getProviderWeightAdjustmentRuleAction(
  ruleId: number
): Promise<ActionResult<Awaited<ReturnType<typeof buildRuleView>>>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    const rule = await repository.getProviderWeightAdjustmentRule(ruleId);
    if (!rule) {
      return { ok: false, error: "Rule not found.", errorCode: "rule_not_found" };
    }
    return { ok: true, data: await buildRuleView(rule) };
  } catch (error) {
    return failure(error);
  }
}

export async function createProviderWeightAdjustmentRuleAction(input: {
  name: string;
  description?: string | null;
  providerType: ProviderType;
  priority: number;
  providerIds: number[];
  isEnabled?: boolean;
}): Promise<ActionResult<Awaited<ReturnType<typeof buildRuleView>>>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    const rule = await repository.createProviderWeightAdjustmentRule(input);
    emitActionAudit({
      category: "provider",
      action: "provider_weight_adjustment_rule.create",
      targetType: "provider_weight_adjustment_rule",
      targetId: rule.id,
      targetName: rule.name,
      after: input,
      success: true,
    });
    return { ok: true, data: await buildRuleView(rule) };
  } catch (error) {
    emitActionAudit({
      category: "provider",
      action: "provider_weight_adjustment_rule.create",
      targetType: "provider_weight_adjustment_rule",
      targetName: input.name,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return failure(error);
  }
}

export async function updateProviderWeightAdjustmentRuleAction(
  ruleId: number,
  input: {
    name?: string;
    description?: string | null;
    providerType?: ProviderType;
    priority?: number;
  }
): Promise<ActionResult<Awaited<ReturnType<typeof buildRuleView>>>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    const before = await repository.getProviderWeightAdjustmentRule(ruleId);
    const rule = await repository.updateProviderWeightAdjustmentRule(ruleId, input);
    emitActionAudit({
      category: "provider",
      action: "provider_weight_adjustment_rule.update",
      targetType: "provider_weight_adjustment_rule",
      targetId: rule.id,
      targetName: rule.name,
      before,
      after: input,
      success: true,
    });
    return { ok: true, data: await buildRuleView(rule) };
  } catch (error) {
    return failure(error);
  }
}

export async function replaceProviderWeightAdjustmentMembersAction(
  ruleId: number,
  providerIds: number[]
): Promise<ActionResult<Awaited<ReturnType<typeof buildRuleView>>>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    const before = await repository.getProviderWeightAdjustmentPreview(ruleId);
    await repository.replaceProviderWeightAdjustmentRuleMembers(ruleId, providerIds);
    const rule = await repository.getProviderWeightAdjustmentRule(ruleId);
    if (!rule) {
      return { ok: false, error: "Rule not found.", errorCode: "rule_not_found" };
    }
    emitActionAudit({
      category: "provider",
      action: "provider_weight_adjustment_rule.members.replace",
      targetType: "provider_weight_adjustment_rule",
      targetId: ruleId,
      targetName: rule.name,
      before: before?.preview.rows.map((row) => row.providerId),
      after: providerIds,
      success: true,
    });
    return { ok: true, data: await buildRuleView(rule) };
  } catch (error) {
    return failure(error);
  }
}

export async function setProviderWeightAdjustmentRuleEnabledAction(
  ruleId: number,
  enabled: boolean
): Promise<ActionResult<Awaited<ReturnType<typeof buildRuleView>>>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    const rule = await repository.setProviderWeightAdjustmentRuleEnabled(ruleId, enabled);
    emitActionAudit({
      category: "provider",
      action: enabled
        ? "provider_weight_adjustment_rule.enable"
        : "provider_weight_adjustment_rule.disable",
      targetType: "provider_weight_adjustment_rule",
      targetId: rule.id,
      targetName: rule.name,
      after: { isEnabled: enabled },
      success: true,
    });
    return { ok: true, data: await buildRuleView(rule) };
  } catch (error) {
    return failure(error);
  }
}

export async function setAllProviderWeightAdjustmentRulesEnabledAction(
  enabled: boolean
): Promise<
  ActionResult<{ enabledRuleIds: number[]; rejected: Array<{ ruleId: number; code: string }> }>
> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    const result = await repository.setAllProviderWeightAdjustmentRulesEnabled(enabled);
    emitActionAudit({
      category: "provider",
      action: enabled
        ? "provider_weight_adjustment_rule.enable_all"
        : "provider_weight_adjustment_rule.disable_all",
      targetType: "provider_weight_adjustment_rule",
      after: result,
      success: true,
    });
    return { ok: true, data: result };
  } catch (error) {
    return failure(error);
  }
}

export async function deleteProviderWeightAdjustmentRuleAction(
  ruleId: number
): Promise<ActionResult> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    const before = await repository.getProviderWeightAdjustmentRule(ruleId);
    await repository.deleteProviderWeightAdjustmentRule(ruleId);
    emitActionAudit({
      category: "provider",
      action: "provider_weight_adjustment_rule.delete",
      targetType: "provider_weight_adjustment_rule",
      targetId: ruleId,
      targetName: before?.name ?? null,
      before,
      success: true,
    });
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function runProviderWeightAdjustmentRuleAction(
  ruleId: number,
  idempotencyKey: string
): Promise<ActionResult<ProviderWeightAdjustmentRun>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    const run = await executeProviderWeightAdjustment({
      ruleId,
      trigger: "manual",
      idempotencyKey,
    });
    emitActionAudit({
      category: "provider",
      action: "provider_weight_adjustment_rule.run",
      targetType: "provider_weight_adjustment_rule",
      targetId: ruleId,
      after: { runId: run.id, idempotencyKey },
      success: true,
    });
    return { ok: true, data: run };
  } catch (error) {
    return failure(error);
  }
}

export async function listProviderWeightAdjustmentRunsAction(
  ruleId: number,
  limit?: number
): Promise<ActionResult<ProviderWeightAdjustmentRun[]>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    return {
      ok: true,
      data: await repository.listProviderWeightAdjustmentRuns(ruleId, limit),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function listProviderWeightAdjustmentRunDetailsAction(
  runId: number
): Promise<ActionResult<ProviderWeightAdjustmentRunDetail[]>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    return {
      ok: true,
      data: await repository.listProviderWeightAdjustmentRunDetails(runId),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function getProviderWeightAdjustmentSettingsAction(): Promise<
  ActionResult<{ intervalMinutes: number }>
> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  try {
    return {
      ok: true,
      data: { intervalMinutes: await repository.getProviderWeightAdjustmentInterval() },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function setProviderWeightAdjustmentSettingsAction(input: {
  intervalMinutes: number;
}): Promise<ActionResult<{ intervalMinutes: number }>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
  }
  if (!PROVIDER_WEIGHT_ADJUSTMENT_INTERVALS.includes(input.intervalMinutes as never)) {
    return {
      ok: false,
      error: "Unsupported interval.",
      errorCode: "invalid_interval",
    };
  }
  try {
    const before = await repository.getProviderWeightAdjustmentInterval();
    const interval = input.intervalMinutes as ProviderWeightAdjustmentIntervalMinutes;
    await repository.setProviderWeightAdjustmentInterval(interval);
    invalidateSystemSettingsCache();
    emitActionAudit({
      category: "system_settings",
      action: "provider_weight_adjustment.interval.update",
      targetType: "system_settings",
      before: { intervalMinutes: before },
      after: { intervalMinutes: interval },
      success: true,
    });
    return { ok: true, data: { intervalMinutes: interval } };
  } catch (error) {
    return failure(error);
  }
}
