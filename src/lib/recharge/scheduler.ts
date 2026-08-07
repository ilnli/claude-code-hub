import { logger } from "@/lib/logger";

const TICK_INTERVAL_MS = 30_000;

const schedulerState = globalThis as typeof globalThis & {
  __CCH_RECHARGE_SETTLEMENT_INTERVAL__?: ReturnType<typeof setInterval>;
  __CCH_RECHARGE_SETTLEMENT_RUNNING__?: boolean;
};

export function startRechargeSettlementScheduler(): void {
  if (schedulerState.__CCH_RECHARGE_SETTLEMENT_INTERVAL__) return;

  const tick = async () => {
    if (schedulerState.__CCH_RECHARGE_SETTLEMENT_RUNNING__) return;
    schedulerState.__CCH_RECHARGE_SETTLEMENT_RUNNING__ = true;
    try {
      const { processDueRechargeSettlements } = await import("@/repository/recharge");
      await processDueRechargeSettlements();
    } catch (error) {
      logger.warn("[Recharge] Settlement scheduler tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      schedulerState.__CCH_RECHARGE_SETTLEMENT_RUNNING__ = false;
    }
  };

  schedulerState.__CCH_RECHARGE_SETTLEMENT_INTERVAL__ = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  schedulerState.__CCH_RECHARGE_SETTLEMENT_INTERVAL__.unref?.();
  void tick();
  logger.info("[Recharge] Settlement scheduler started", {
    intervalSeconds: TICK_INTERVAL_MS / 1000,
  });
}

export function stopRechargeSettlementScheduler(): void {
  const interval = schedulerState.__CCH_RECHARGE_SETTLEMENT_INTERVAL__;
  if (interval) clearInterval(interval);
  schedulerState.__CCH_RECHARGE_SETTLEMENT_INTERVAL__ = undefined;
}
