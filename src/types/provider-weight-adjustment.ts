import type { ProviderType } from "./provider";

export const PROVIDER_WEIGHT_ADJUSTMENT_INTERVALS = [10, 30, 60, 360, 1440] as const;

export type ProviderWeightAdjustmentIntervalMinutes =
  (typeof PROVIDER_WEIGHT_ADJUSTMENT_INTERVALS)[number];

export type ProviderWeightAdjustmentTrigger = "scheduled" | "manual";

export type ProviderWeightAdjustmentRunStatus =
  | "running"
  | "succeeded"
  | "succeeded_with_warning"
  | "failed"
  | "skipped";

export type ProviderWeightAdjustmentDetailOutcome = "changed" | "skipped" | "failed";

export type ProviderWeightAdjustmentSkipReason =
  | "disabled"
  | "type_mismatch"
  | "priority_mismatch"
  | "invalid_cost"
  | "insufficient_participants";

export type ProviderWeightAdjustmentFaultKind =
  | "run_failed"
  | "coordination_failed"
  | "scheduler_failed"
  | "overlap"
  | "insufficient_participants"
  | "cache_invalidation_failed";

export interface ProviderWeightAdjustmentRule {
  id: number;
  name: string;
  description: string | null;
  providerType: ProviderType;
  priority: number;
  isEnabled: boolean;
  revision: number;
  nextRunAt: Date | null;
  activeRunId: number | null;
  faultActive: boolean;
  faultKind: ProviderWeightAdjustmentFaultKind | null;
  faultMessage: string | null;
  faultStartedAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ProviderWeightAdjustmentMember {
  id: number;
  ruleId: number;
  providerId: number;
  createdAt: Date;
}

export interface ProviderWeightAdjustmentRunSummary {
  memberCount: number;
  participantCount: number;
  changedCount: number;
  skippedCount: number;
  failedCount: number;
}

export interface ProviderWeightAdjustmentRun {
  id: number;
  ruleId: number;
  trigger: ProviderWeightAdjustmentTrigger;
  status: ProviderWeightAdjustmentRunStatus;
  idempotencyKey: string | null;
  ruleName: string;
  providerType: ProviderType;
  priority: number;
  ruleRevision: number;
  summary: ProviderWeightAdjustmentRunSummary;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
  expiresAt: Date;
}

export interface ProviderWeightAdjustmentRunDetail {
  id: number;
  runId: number;
  providerId: number;
  providerName: string;
  outcome: ProviderWeightAdjustmentDetailOutcome;
  costMultiplier: string | null;
  previousWeight: number;
  projectedWeight: number | null;
  reason: string | null;
  createdAt: Date;
}
