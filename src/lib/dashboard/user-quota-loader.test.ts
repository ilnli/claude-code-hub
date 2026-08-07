import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResetInfoWithMode: vi.fn(),
  getTimeRangeForPeriodWithMode: vi.fn(),
  resolveSystemTimezone: vi.fn(),
  sumUserCostInTimeRangeBatch: vi.fn(),
}));

vi.mock("@/lib/rate-limit/time-utils", () => ({
  getResetInfoWithMode: mocks.getResetInfoWithMode,
  getTimeRangeForPeriodWithMode: mocks.getTimeRangeForPeriodWithMode,
}));

vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: mocks.resolveSystemTimezone,
}));

vi.mock("@/repository/statistics", () => ({
  sumUserCostInTimeRangeBatch: mocks.sumUserCostInTimeRangeBatch,
}));

describe("loadUserQuotaSnapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSystemTimezone.mockResolvedValue("UTC");
    mocks.getTimeRangeForPeriodWithMode.mockResolvedValue({
      startTime: new Date("2026-08-06T00:00:00.000Z"),
      endTime: new Date("2026-08-07T00:00:00.000Z"),
    });
    mocks.getResetInfoWithMode.mockResolvedValue({
      type: "custom",
      resetAt: new Date("2026-08-08T00:00:00.000Z"),
    });
    mocks.sumUserCostInTimeRangeBatch.mockResolvedValue(
      new Map([
        [1, 12.5],
        [2, 7.25],
      ])
    );
  });

  test("loads all daily costs through one batch and reuses matching window calculations", async () => {
    const { loadUserQuotaSnapshots } = await import("./user-quota-loader");
    const resetAt = new Date("2026-08-06T12:00:00.000Z");

    const result = await loadUserQuotaSnapshots([
      {
        id: 1,
        rpm: 60,
        dailyQuota: 20,
        dailyResetMode: "fixed",
        dailyResetTime: "00:00",
        costResetAt: resetAt,
      },
      {
        id: 2,
        rpm: null,
        dailyQuota: null,
        dailyResetMode: "fixed",
        dailyResetTime: "00:00",
        costResetAt: null,
      },
    ]);

    expect(mocks.resolveSystemTimezone).toHaveBeenCalledTimes(1);
    expect(mocks.getTimeRangeForPeriodWithMode).toHaveBeenCalledTimes(1);
    expect(mocks.getResetInfoWithMode).toHaveBeenCalledTimes(1);
    expect(mocks.sumUserCostInTimeRangeBatch).toHaveBeenCalledTimes(1);
    expect(mocks.sumUserCostInTimeRangeBatch).toHaveBeenCalledWith(
      new Map([
        [
          1,
          {
            startTime: resetAt,
            endTime: new Date("2026-08-07T00:00:00.000Z"),
          },
        ],
        [
          2,
          {
            startTime: new Date("2026-08-06T00:00:00.000Z"),
            endTime: new Date("2026-08-07T00:00:00.000Z"),
          },
        ],
      ])
    );
    expect(result.get(1)).toEqual({
      rpm: { current: 0, limit: 60, window: "per_minute" },
      dailyCost: {
        current: 12.5,
        limit: 20,
        resetAt: new Date("2026-08-08T00:00:00.000Z"),
      },
    });
    expect(result.get(2)?.dailyCost.current).toBe(7.25);
  });

  test("returns immediately for an empty user list", async () => {
    const { loadUserQuotaSnapshots } = await import("./user-quota-loader");

    await expect(loadUserQuotaSnapshots([])).resolves.toEqual(new Map());
    expect(mocks.resolveSystemTimezone).not.toHaveBeenCalled();
    expect(mocks.sumUserCostInTimeRangeBatch).not.toHaveBeenCalled();
  });
});
