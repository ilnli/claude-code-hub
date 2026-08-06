"use client";

import type { ProviderType } from "@/types/provider";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, searchParams, unwrapItems } from "./_compat";

export type WeightAdjustmentSkipReason =
  | "disabled"
  | "type_mismatch"
  | "priority_mismatch"
  | "invalid_cost"
  | "insufficient_participants";

export interface WeightAdjustmentPreviewRow {
  providerId: number;
  providerName: string;
  providerType: ProviderType;
  priority: number;
  isEnabled: boolean;
  currentWeight: number;
  parsedCostMultiplier: number | null;
  projectedWeight: number | null;
  projectedShare: number | null;
  participates: boolean;
  skipReason: WeightAdjustmentSkipReason | null;
}

export interface WeightAdjustmentRuleView {
  id: number;
  name: string;
  description: string | null;
  providerType: ProviderType;
  priority: number;
  isEnabled: boolean;
  revision: number;
  nextRunAt: string | null;
  activeRunId: number | null;
  faultActive: boolean;
  faultKind: string | null;
  faultMessage: string | null;
  faultStartedAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  preview: {
    rows: WeightAdjustmentPreviewRow[];
    memberCount: number;
    participantCount: number;
    changedCount: number;
    skippedCount: number;
    actionable: boolean;
  };
}

export interface WeightAdjustmentRunView {
  id: number;
  ruleId: number;
  trigger: "scheduled" | "manual";
  status: "running" | "succeeded" | "succeeded_with_warning" | "failed" | "skipped";
  summary: {
    memberCount: number;
    participantCount: number;
    changedCount: number;
    skippedCount: number;
    failedCount: number;
  };
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export function getWeightAdjustmentRules(): Promise<WeightAdjustmentRuleView[]> {
  return apiGet<{ items: WeightAdjustmentRuleView[] }>(
    "/api/v1/provider-weight-adjustment-rules"
  ).then(unwrapItems);
}

export function createWeightAdjustmentRule(input: {
  name: string;
  description?: string | null;
  providerType: ProviderType;
  priority: number;
  providerIds: number[];
}) {
  return apiPost<WeightAdjustmentRuleView>("/api/v1/provider-weight-adjustment-rules", input);
}

export function updateWeightAdjustmentRule(
  ruleId: number,
  input: Partial<
    Pick<WeightAdjustmentRuleView, "name" | "description" | "providerType" | "priority">
  >
) {
  return apiPatch<WeightAdjustmentRuleView>(
    `/api/v1/provider-weight-adjustment-rules/${ruleId}`,
    input
  );
}

export function replaceWeightAdjustmentRuleMembers(ruleId: number, providerIds: number[]) {
  return apiPut<WeightAdjustmentRuleView>(
    `/api/v1/provider-weight-adjustment-rules/${ruleId}/members`,
    { providerIds }
  );
}

export function setWeightAdjustmentRuleEnabled(ruleId: number, enabled: boolean) {
  return apiPost<WeightAdjustmentRuleView>(
    `/api/v1/provider-weight-adjustment-rules/${ruleId}/${enabled ? "enable" : "disable"}`
  );
}

export function setAllWeightAdjustmentRulesEnabled(enabled: boolean) {
  return apiPost<{ enabledRuleIds: number[]; rejected: Array<{ ruleId: number; code: string }> }>(
    `/api/v1/provider-weight-adjustment-rules:${enabled ? "enableAll" : "disableAll"}`
  );
}

export function deleteWeightAdjustmentRule(ruleId: number) {
  return apiDelete(`/api/v1/provider-weight-adjustment-rules/${ruleId}`);
}

export function runWeightAdjustmentRule(ruleId: number) {
  return apiPost<WeightAdjustmentRunView>(
    `/api/v1/provider-weight-adjustment-rules/${ruleId}/run`,
    undefined,
    { headers: { "Idempotency-Key": crypto.randomUUID() } }
  );
}

export function getWeightAdjustmentRuns(ruleId: number, limit = 50) {
  return apiGet<{ items: WeightAdjustmentRunView[] }>(
    `/api/v1/provider-weight-adjustment-rules/${ruleId}/runs${searchParams({ limit })}`
  ).then(unwrapItems);
}

export function getWeightAdjustmentSettings() {
  return apiGet<{ intervalMinutes: number }>("/api/v1/provider-weight-adjustment-settings");
}

export function updateWeightAdjustmentSettings(intervalMinutes: number) {
  return apiPut<{ intervalMinutes: number }>("/api/v1/provider-weight-adjustment-settings", {
    intervalMinutes,
  });
}
