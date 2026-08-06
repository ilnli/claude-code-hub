import type { ProviderType } from "@/types/provider";
import type { ProviderWeightAdjustmentSkipReason } from "@/types/provider-weight-adjustment";

export interface WeightAdjustmentRuleScope {
  providerType: ProviderType;
  priority: number;
}

export interface WeightAdjustmentMemberInput {
  providerId: number;
  providerName: string;
  providerType: ProviderType;
  priority: number;
  isEnabled: boolean;
  costMultiplier: number | string | null;
  currentWeight: number;
}

export interface WeightAdjustmentPreviewRow extends WeightAdjustmentMemberInput {
  parsedCostMultiplier: number | null;
  projectedWeight: number | null;
  projectedShare: number | null;
  participates: boolean;
  skipReason: ProviderWeightAdjustmentSkipReason | null;
}

export interface WeightAdjustmentPreview {
  rows: WeightAdjustmentPreviewRow[];
  memberCount: number;
  participantCount: number;
  changedCount: number;
  skippedCount: number;
  actionable: boolean;
}

function parseCostMultiplier(value: number | string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getSkipReason(
  scope: WeightAdjustmentRuleScope,
  member: WeightAdjustmentMemberInput,
  parsedCostMultiplier: number | null
): ProviderWeightAdjustmentSkipReason | null {
  if (!member.isEnabled) return "disabled";
  if (member.providerType !== scope.providerType) return "type_mismatch";
  if (member.priority !== scope.priority) return "priority_mismatch";
  if (parsedCostMultiplier === null) return "invalid_cost";
  return null;
}

function clampWeight(weight: number): number {
  return Math.min(100, Math.max(1, weight));
}

export function calculateProviderWeightAdjustment(
  scope: WeightAdjustmentRuleScope,
  members: WeightAdjustmentMemberInput[]
): WeightAdjustmentPreview {
  const classified = members.map((member) => {
    const parsedCostMultiplier = parseCostMultiplier(member.costMultiplier);
    return {
      member,
      parsedCostMultiplier,
      skipReason: getSkipReason(scope, member, parsedCostMultiplier),
    };
  });

  const participants = classified.filter(
    (entry): entry is typeof entry & { parsedCostMultiplier: number; skipReason: null } =>
      entry.skipReason === null && entry.parsedCostMultiplier !== null
  );
  const actionable = participants.length >= 2;

  const projectedWeights = new Map<number, number>();
  if (actionable) {
    // Scaling every inverse by the minimum cost keeps the ratio exact while avoiding
    // overflow for very small positive multipliers.
    const minimumCost = Math.min(...participants.map((entry) => entry.parsedCostMultiplier));
    const inverseRatios = participants.map((entry) => ({
      providerId: entry.member.providerId,
      ratio: minimumCost / entry.parsedCostMultiplier,
    }));
    const ratioSum = inverseRatios.reduce((sum, entry) => sum + entry.ratio, 0);

    for (const entry of inverseRatios) {
      const unboundedWeight = (50 * participants.length * entry.ratio) / ratioSum;
      projectedWeights.set(entry.providerId, clampWeight(Math.round(unboundedWeight)));
    }
  }

  const projectedWeightSum = Array.from(projectedWeights.values()).reduce(
    (sum, weight) => sum + weight,
    0
  );
  const rows = classified.map<WeightAdjustmentPreviewRow>((entry) => {
    const participates = entry.skipReason === null && actionable;
    const projectedWeight = participates
      ? (projectedWeights.get(entry.member.providerId) ?? null)
      : null;
    return {
      ...entry.member,
      parsedCostMultiplier: entry.parsedCostMultiplier,
      projectedWeight,
      projectedShare:
        projectedWeight !== null && projectedWeightSum > 0
          ? projectedWeight / projectedWeightSum
          : null,
      participates,
      skipReason: entry.skipReason ?? (actionable ? null : ("insufficient_participants" as const)),
    };
  });

  return {
    rows,
    memberCount: rows.length,
    participantCount: participants.length,
    changedCount: rows.filter(
      (row) => row.projectedWeight !== null && row.projectedWeight !== row.currentWeight
    ).length,
    skippedCount: rows.filter((row) => !row.participates).length,
    actionable,
  };
}
