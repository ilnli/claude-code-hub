import "server-only";

import { clipStartByResetAt } from "@/lib/rate-limit/cost-reset-utils";
import {
  getResetInfoWithMode,
  getTimeRangeForPeriodWithMode,
  type ResetInfo,
  type TimeRange,
} from "@/lib/rate-limit/time-utils";
import { resolveSystemTimezone } from "@/lib/utils/timezone";
import { sumUserCostInTimeRangeBatch } from "@/repository/statistics";

interface UserQuotaSource {
  id: number;
  rpm: number | null;
  dailyQuota: number | null;
  dailyResetMode?: "fixed" | "rolling";
  dailyResetTime?: string;
  costResetAt?: Date | null;
}

export interface UserQuotaSnapshot {
  rpm: { current: number; limit: number | null; window: "per_minute" };
  dailyCost: { current: number; limit: number | null; resetAt?: Date };
}

interface DailyWindow {
  range: TimeRange;
  resetInfo: ResetInfo;
}

export async function loadUserQuotaSnapshots(
  users: UserQuotaSource[]
): Promise<Map<number, UserQuotaSnapshot>> {
  const snapshots = new Map<number, UserQuotaSnapshot>();
  if (users.length === 0) return snapshots;

  const timezone = await resolveSystemTimezone();
  const now = new Date();
  const windowCache = new Map<string, Promise<DailyWindow>>();

  const criteria = await Promise.all(
    users.map(async (user) => {
      const resetTime = user.dailyResetTime ?? "00:00";
      const resetMode = user.dailyResetMode ?? "fixed";
      const cacheKey = `${resetMode}:${resetTime}`;
      let windowPromise = windowCache.get(cacheKey);
      if (!windowPromise) {
        const options = { timezone, now };
        windowPromise = Promise.all([
          getTimeRangeForPeriodWithMode("daily", resetTime, resetMode, options),
          getResetInfoWithMode("daily", resetTime, resetMode, undefined, options),
        ]).then(([range, resetInfo]) => ({ range, resetInfo }));
        windowCache.set(cacheKey, windowPromise);
      }

      const { range, resetInfo } = await windowPromise;
      return {
        user,
        range: {
          startTime: clipStartByResetAt(range.startTime, user.costResetAt ?? null),
          endTime: range.endTime,
        },
        resetAt: resetInfo.resetAt,
      };
    })
  );

  const usageByUserId = await sumUserCostInTimeRangeBatch(
    new Map(criteria.map(({ user, range }) => [user.id, range]))
  );

  for (const { user, resetAt } of criteria) {
    snapshots.set(user.id, {
      rpm: { current: 0, limit: user.rpm, window: "per_minute" },
      dailyCost: {
        current: usageByUserId.get(user.id) ?? 0,
        limit: user.dailyQuota,
        ...(resetAt ? { resetAt } : {}),
      },
    });
  }

  return snapshots;
}
