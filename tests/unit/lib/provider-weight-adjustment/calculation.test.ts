import { describe, expect, it } from "vitest";
import {
  calculateProviderWeightAdjustment,
  type WeightAdjustmentMemberInput,
} from "@/lib/provider-weight-adjustment/calculation";

const scope = { providerType: "claude" as const, priority: 2 };

function member(
  providerId: number,
  costMultiplier: number | string | null,
  overrides: Partial<WeightAdjustmentMemberInput> = {}
): WeightAdjustmentMemberInput {
  return {
    providerId,
    providerName: `Provider ${providerId}`,
    providerType: "claude",
    priority: 2,
    isEnabled: true,
    costMultiplier,
    currentWeight: 1,
    ...overrides,
  };
}

describe("calculateProviderWeightAdjustment", () => {
  it("normalizes equal costs to weights of 50", () => {
    const result = calculateProviderWeightAdjustment(scope, [member(1, 0.2), member(2, 0.2)]);

    expect(result.rows.map((row) => row.projectedWeight)).toEqual([50, 50]);
    expect(result.rows.map((row) => row.projectedShare)).toEqual([0.5, 0.5]);
    expect(result.actionable).toBe(true);
  });

  it("preserves inverse-cost proportions for multipliers below one", () => {
    const result = calculateProviderWeightAdjustment(scope, [
      member(1, 0.1),
      member(2, 0.2),
      member(3, 0.4),
    ]);

    expect(result.rows.map((row) => row.projectedWeight)).toEqual([86, 43, 21]);
  });

  it("clamps extreme results without redistributing", () => {
    const result = calculateProviderWeightAdjustment(scope, [
      member(1, 0.0001),
      member(2, 100),
      member(3, 100),
    ]);

    expect(result.rows.map((row) => row.projectedWeight)).toEqual([100, 1, 1]);
  });

  it("avoids reciprocal overflow for extremely small positive costs", () => {
    const result = calculateProviderWeightAdjustment(scope, [
      member(1, Number.MIN_VALUE),
      member(2, Number.MIN_VALUE),
    ]);

    expect(result.rows.map((row) => row.projectedWeight)).toEqual([50, 50]);
  });

  it("skips disabled, mismatched, and invalid-cost members", () => {
    const result = calculateProviderWeightAdjustment(scope, [
      member(1, 0.5),
      member(2, 1),
      member(3, 1, { isEnabled: false }),
      member(4, 1, { providerType: "codex" }),
      member(5, 1, { priority: 3 }),
      member(6, 0),
      member(7, "not-a-number"),
    ]);

    expect(result.participantCount).toBe(2);
    expect(result.rows.map((row) => row.skipReason)).toEqual([
      null,
      null,
      "disabled",
      "type_mismatch",
      "priority_mismatch",
      "invalid_cost",
      "invalid_cost",
    ]);
    expect(result.rows.slice(0, 2).map((row) => row.projectedWeight)).toEqual([67, 33]);
  });

  it("does not calculate when fewer than two valid participants remain", () => {
    const result = calculateProviderWeightAdjustment(scope, [
      member(1, 1),
      member(2, 1, { isEnabled: false }),
    ]);

    expect(result.actionable).toBe(false);
    expect(result.changedCount).toBe(0);
    expect(result.rows.map((row) => row.projectedWeight)).toEqual([null, null]);
    expect(result.rows.map((row) => row.skipReason)).toEqual([
      "insufficient_participants",
      "disabled",
    ]);
  });

  it("reports only actual weight changes", () => {
    const result = calculateProviderWeightAdjustment(scope, [
      member(1, 1, { currentWeight: 50 }),
      member(2, 1, { currentWeight: 40 }),
    ]);

    expect(result.changedCount).toBe(1);
  });
});
