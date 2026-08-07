import { describe, expect, it } from "vitest";
import { getRechargeRetryDelayMs } from "@/lib/recharge/retry";

describe("recharge settlement retry schedule", () => {
  it("uses one, five, and thirty minute delays", () => {
    expect(getRechargeRetryDelayMs(0, false)).toBe(60_000);
    expect(getRechargeRetryDelayMs(1, true)).toBe(5 * 60_000);
    expect(getRechargeRetryDelayMs(2, true)).toBe(30 * 60_000);
    expect(getRechargeRetryDelayMs(3, true)).toBeNull();
  });

  it("does not create another automatic retry after exhaustion", () => {
    expect(getRechargeRetryDelayMs(3, false)).toBeNull();
  });
});
