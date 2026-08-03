import { describe, expect, it } from "vitest";
import { resolveCostMultiplierForSubmit } from "@/app/[locale]/settings/providers/_components/forms/provider-form/provider-form-payload";

describe("resolveCostMultiplierForSubmit", () => {
  it("omits cost_multiplier when follow stays on in edit mode", () => {
    const result = resolveCostMultiplierForSubmit({
      mode: "edit",
      initialRateFollowUpstream: true,
      currentRateFollowUpstream: true,
      initialCostMultiplier: 1.25,
      currentCostMultiplier: 1.25,
    });

    expect(result).toBeUndefined();
  });

  it("omits cost_multiplier when follow stays on even if the snapshotted value differs (e.g. probe wrote a new value)", () => {
    const result = resolveCostMultiplierForSubmit({
      mode: "edit",
      initialRateFollowUpstream: true,
      currentRateFollowUpstream: true,
      initialCostMultiplier: 1.0,
      currentCostMultiplier: 1.4,
    });

    expect(result).toBeUndefined();
  });

  it("includes cost_multiplier when follow transitions true -> false and the user edited the value", () => {
    const result = resolveCostMultiplierForSubmit({
      mode: "edit",
      initialRateFollowUpstream: true,
      currentRateFollowUpstream: false,
      initialCostMultiplier: 1.0,
      currentCostMultiplier: 1.5,
    });

    expect(result).toBe(1.5);
  });

  it("omits cost_multiplier when follow transitions true -> false and the value was left untouched", () => {
    const result = resolveCostMultiplierForSubmit({
      mode: "edit",
      initialRateFollowUpstream: true,
      currentRateFollowUpstream: false,
      initialCostMultiplier: 1.0,
      currentCostMultiplier: 1.0,
    });

    expect(result).toBeUndefined();
  });

  it("includes cost_multiplier when follow was off throughout edit mode", () => {
    const result = resolveCostMultiplierForSubmit({
      mode: "edit",
      initialRateFollowUpstream: false,
      currentRateFollowUpstream: false,
      initialCostMultiplier: 1.0,
      currentCostMultiplier: 0.8,
    });

    expect(result).toBe(0.8);
  });

  it("includes cost_multiplier when follow transitions false -> true in edit mode (unchanged behavior)", () => {
    const result = resolveCostMultiplierForSubmit({
      mode: "edit",
      initialRateFollowUpstream: false,
      currentRateFollowUpstream: true,
      initialCostMultiplier: 1.0,
      currentCostMultiplier: 1.0,
    });

    expect(result).toBe(1.0);
  });

  it("always includes cost_multiplier in create mode, regardless of follow flags", () => {
    const result = resolveCostMultiplierForSubmit({
      mode: "create",
      initialRateFollowUpstream: false,
      currentRateFollowUpstream: true,
      initialCostMultiplier: 1.0,
      currentCostMultiplier: 2.0,
    });

    expect(result).toBe(2.0);
  });

  it("always includes cost_multiplier in batch mode, regardless of follow flags", () => {
    const result = resolveCostMultiplierForSubmit({
      mode: "batch",
      initialRateFollowUpstream: true,
      currentRateFollowUpstream: true,
      initialCostMultiplier: 1.0,
      currentCostMultiplier: 3.0,
    });

    expect(result).toBe(3.0);
  });
});
