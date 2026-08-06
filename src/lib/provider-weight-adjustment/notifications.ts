import { logger } from "@/lib/logger";
import type { ProviderWeightAdjustmentAlertData } from "@/lib/webhook/types";

export async function sendProviderWeightAdjustmentAlert(
  data: ProviderWeightAdjustmentAlertData
): Promise<void> {
  try {
    const { getNotificationSettings } = await import("@/repository/notifications");
    const settings = await getNotificationSettings();
    if (!settings.enabled || settings.useLegacyMode || !settings.weightAdjustmentAlertEnabled) {
      return;
    }
    const { getEnabledBindingsByType } = await import("@/repository/notification-bindings");
    const bindings = await getEnabledBindingsByType("weight_adjustment_alert");
    const { addNotificationJobForTarget } = await import("@/lib/notification/notification-queue");
    for (const binding of bindings) {
      await addNotificationJobForTarget(
        "weight-adjustment-alert",
        binding.targetId,
        binding.id,
        data
      );
    }
  } catch (error) {
    logger.warn("[ProviderWeightAdjustment] failed to enqueue alert", {
      ruleId: data.ruleId,
      event: data.event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
