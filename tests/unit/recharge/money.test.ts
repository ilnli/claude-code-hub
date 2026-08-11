import { describe, expect, it } from "vitest";
import {
  calculateAlipayAmount,
  isAmountWithinRange,
  normalizeCreditAmount,
} from "@/lib/recharge/money";

describe("recharge money", () => {
  it("adds the configured fee to the recharge amount and rounds upward to cents", () => {
    expect(calculateAlipayAmount("100", "0.38")).toBe("100.38");
    expect(calculateAlipayAmount("1", "0")).toBe("1.00");
    expect(calculateAlipayAmount("10.01", "3.5")).toBe("10.37");
  });

  it("normalizes valid credit values and rejects fractions beyond cents", () => {
    expect(normalizeCreditAmount("10")).toBe("10.00");
    expect(normalizeCreditAmount("10.5")).toBe("10.50");
    expect(() => normalizeCreditAmount("0")).toThrow("INVALID_CREDIT_AMOUNT");
    expect(() => normalizeCreditAmount("1.001")).toThrow("INVALID_CREDIT_AMOUNT");
  });

  it("checks the configured net-credit range", () => {
    expect(isAmountWithinRange("1", "1", "1000")).toBe(true);
    expect(isAmountWithinRange("1000", "1", "1000")).toBe(true);
    expect(isAmountWithinRange("0.99", "1", "1000")).toBe(false);
    expect(isAmountWithinRange("1000.01", "1", "1000")).toBe(false);
  });
});
