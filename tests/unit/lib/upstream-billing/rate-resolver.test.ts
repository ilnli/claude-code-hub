import { describe, expect, it } from "vitest";
import { applyMarkup, isValidUpstreamRate, roundRate4 } from "@/lib/upstream-billing/rate-resolver";

describe("roundRate4", () => {
  it("rounds to 4 decimal places", () => {
    expect(roundRate4(1.23456789)).toBe(1.2346);
    expect(roundRate4(1)).toBe(1);
    expect(roundRate4(0.00004)).toBe(0);
    expect(roundRate4(0.00006)).toBe(0.0001);
  });
});

describe("isValidUpstreamRate", () => {
  it("accepts rates in (0, 100]", () => {
    expect(isValidUpstreamRate(0.0001)).toBe(true);
    expect(isValidUpstreamRate(1)).toBe(true);
    expect(isValidUpstreamRate(100)).toBe(true);
  });

  it("rejects rates outside (0, 100]", () => {
    expect(isValidUpstreamRate(0)).toBe(false);
    expect(isValidUpstreamRate(-1)).toBe(false);
    expect(isValidUpstreamRate(100.0001)).toBe(false);
    expect(isValidUpstreamRate(Number.NaN)).toBe(false);
    expect(isValidUpstreamRate(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("applyMarkup", () => {
  it("returns base unchanged when markup type is none", () => {
    expect(applyMarkup(1.5, "none", 0)).toBe(1.5);
    expect(applyMarkup(1.5, "none", 99)).toBe(1.5);
  });

  it("applies percent markup (0.1 = +10%)", () => {
    expect(applyMarkup(1.0, "percent", 0.1)).toBe(1.1);
    expect(applyMarkup(1.6, "percent", 0.1)).toBe(1.76);
    expect(applyMarkup(2.5, "percent", 0)).toBe(2.5);
  });

  it("applies fixed markup (+0.01)", () => {
    expect(applyMarkup(1.0, "fixed", 0.01)).toBe(1.01);
    expect(applyMarkup(1.2345, "fixed", 0.01)).toBe(1.2445);
  });

  it("rounds result to 4 decimal places", () => {
    // 1.0001 * 1.1 = 1.10011 -> 1.1001
    expect(applyMarkup(1.0001, "percent", 0.1)).toBe(1.1001);
  });

  it("clamps result to 100", () => {
    expect(applyMarkup(100, "percent", 0.5)).toBe(100);
    expect(applyMarkup(99.9999, "fixed", 1)).toBe(100);
  });

  it("never returns negative or non-finite values", () => {
    expect(applyMarkup(0, "fixed", 0)).toBe(0);
    expect(applyMarkup(Number.NaN, "none", 0)).toBe(0);
  });
});
