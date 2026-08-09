import { describe, expect, test } from "vitest";
import {
  advanceAutomaticBaselineHistory,
  buildFixedPolicyOverride,
  calculateBaselineLagMinimum,
  compareClientVersions,
  computeAutomaticVersionBaseline,
  evaluateClientVersion,
  normalizeClientVersion,
  resolveEffectiveClientVersionRange,
} from "@/lib/client-version-policy";
import type { ClientVersionPolicy } from "@/types/client-version-policy";

function policy(overrides: Partial<ClientVersionPolicy>): ClientVersionPolicy {
  return {
    id: 1,
    clientType: "claude-cli",
    mode: "automatic_baseline",
    minimumVersion: null,
    maximumVersion: null,
    baselineLag: null,
    automaticBaseline: null,
    previousSeriesTerminalVersion: null,
    baselineUpdatedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("client version policy", () => {
  test("normalizes the numeric core while ignoring prefixes and suffixes", () => {
    expect(normalizeClientVersion("v2.01.003-beta.1")).toBe("2.1.3");
    expect(normalizeClientVersion("2.1.3+build.7")).toBe("2.1.3");
    expect(normalizeClientVersion("2.1")).toBeNull();
    expect(normalizeClientVersion("dev")).toBeNull();
  });

  test("compares only major, minor, and patch components", () => {
    expect(compareClientVersions("2.0.1-beta.1", "2.0.1")).toBe(0);
    expect(compareClientVersions("1.9.10", "2.0.0")).toBe(-1);
    expect(compareClientVersions("2.1.0", "2.0.99")).toBe(1);
  });

  test("groups suffix variants into one adoption bucket", () => {
    expect(
      computeAutomaticVersionBaseline(
        [
          { userId: 1, version: "2.0.1-beta.1" },
          { userId: 2, version: "2.0.1" },
          { userId: 1, version: "2.0.2" },
        ],
        2
      )
    ).toBe("2.0.1");
  });

  test("allows one user to contribute to multiple comparable versions", () => {
    expect(
      computeAutomaticVersionBaseline(
        [
          { userId: 1, version: "2.0.1" },
          { userId: 2, version: "2.0.1" },
          { userId: 1, version: "2.0.2" },
          { userId: 2, version: "2.0.2" },
        ],
        2
      )
    ).toBe("2.0.2");
  });

  test("calculates lag within a version series", () => {
    expect(calculateBaselineLagMinimum("2.0.2", 2, null)).toBe("2.0.0");
    expect(calculateBaselineLagMinimum("2.0.5", 3, null)).toBe("2.0.2");
  });

  test("clamps a cross-series lag to one stored terminal version", () => {
    expect(calculateBaselineLagMinimum("2.0.1", 2, "1.9.10")).toBe("1.9.10");
    expect(calculateBaselineLagMinimum("2.0.1", 13, "1.9.10")).toBe("1.9.10");
    expect(calculateBaselineLagMinimum("2.0.1", 2, null)).toBe("2.0.0");
  });

  test("resolves baseline-driven and fixed effective ranges", () => {
    expect(
      resolveEffectiveClientVersionRange(
        policy({ mode: "automatic_baseline", automaticBaseline: "2.0.2" })
      )
    ).toEqual({ minimumVersion: "2.0.2", maximumVersion: null, waitingForBaseline: false });
    expect(
      resolveEffectiveClientVersionRange(
        policy({
          mode: "baseline_lag",
          baselineLag: 2,
          automaticBaseline: "2.0.1",
          previousSeriesTerminalVersion: "1.9.10",
        })
      )
    ).toEqual({ minimumVersion: "1.9.10", maximumVersion: null, waitingForBaseline: false });
    expect(
      resolveEffectiveClientVersionRange(
        policy({ mode: "range", minimumVersion: "2.0.0", maximumVersion: "2.0.2" })
      )
    ).toEqual({ minimumVersion: "2.0.0", maximumVersion: "2.0.2", waitingForBaseline: false });
  });

  test("classifies both boundaries and malformed versions", () => {
    const fixed = policy({
      mode: "range",
      minimumVersion: "2.0.0",
      maximumVersion: "2.0.2",
    });
    expect(evaluateClientVersion("1.9.10", fixed).status).toBe("below_minimum");
    expect(evaluateClientVersion("2.0.1-beta", fixed).status).toBe("within_range");
    expect(evaluateClientVersion("2.0.3", fixed).status).toBe("above_maximum");
    expect(evaluateClientVersion("dev", fixed).status).toBe("unparseable");
    expect(evaluateClientVersion("2.0.1", null).status).toBe("unchecked");
  });

  test("advances monotonically and records only the prior adopted series", () => {
    expect(advanceAutomaticBaselineHistory("2.0.2", "2.0.1", "1.9.10")).toEqual({
      automaticBaseline: "2.0.2",
      previousSeriesTerminalVersion: "1.9.10",
      changed: false,
    });
    expect(advanceAutomaticBaselineHistory("1.9.10", "2.1.0", null)).toEqual({
      automaticBaseline: "2.1.0",
      previousSeriesTerminalVersion: "1.9.10",
      changed: true,
    });
  });

  test("converts automatic policies into the confirmed fixed ranges", () => {
    expect(buildFixedPolicyOverride(policy({ mode: "automatic_baseline" }), "2.0.1-beta")).toEqual({
      mode: "range",
      minimumVersion: "2.0.1",
      maximumVersion: "2.0.1",
    });
    expect(
      buildFixedPolicyOverride(policy({ mode: "baseline_lag", baselineLag: 3 }), "2.0.5")
    ).toEqual({ mode: "range", minimumVersion: "2.0.2", maximumVersion: "2.0.5" });
    expect(
      buildFixedPolicyOverride(policy({ mode: "baseline_lag", baselineLag: 3 }), "2.0.1")
    ).toEqual({ mode: "range", minimumVersion: "2.0.0", maximumVersion: "2.0.1" });
  });
});
