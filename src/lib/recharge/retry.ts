export const RECHARGE_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

export function getRechargeRetryDelayMs(
  retryCount: number,
  automaticAttempt: boolean
): number | null {
  if (!automaticAttempt) return retryCount >= 3 ? null : RECHARGE_RETRY_DELAYS_MS[0];
  return RECHARGE_RETRY_DELAYS_MS[retryCount] ?? null;
}
