import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addJob: vi.fn(),
  getBindings: vi.fn(),
  getSettings: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/repository/notifications", () => ({
  getNotificationSettings: mocks.getSettings,
}));

vi.mock("@/repository/notification-bindings", () => ({
  getEnabledBindingsByType: mocks.getBindings,
}));

vi.mock("@/lib/notification/notification-queue", () => ({
  addNotificationJobForTarget: mocks.addJob,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: mocks.warn },
}));

import { sendProviderWeightAdjustmentAlert } from "@/lib/provider-weight-adjustment/notifications";

const alert = {
  event: "fault" as const,
  ruleId: 4,
  ruleName: "Cost pool",
  runId: 8,
  faultKind: "run_failed" as const,
  message: "write conflict",
  generatedAt: "2026-08-06T00:00:00.000Z",
};

describe("sendProviderWeightAdjustmentAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({
      enabled: true,
      useLegacyMode: false,
      weightAdjustmentAlertEnabled: true,
    });
    mocks.getBindings.mockResolvedValue([
      { id: 10, targetId: 20 },
      { id: 11, targetId: 21 },
    ]);
    mocks.addJob.mockResolvedValue(undefined);
  });

  it("queues the alert for each enabled binding", async () => {
    await sendProviderWeightAdjustmentAlert(alert);

    expect(mocks.getBindings).toHaveBeenCalledWith("weight_adjustment_alert");
    expect(mocks.addJob).toHaveBeenNthCalledWith(1, "weight-adjustment-alert", 20, 10, alert);
    expect(mocks.addJob).toHaveBeenNthCalledWith(2, "weight-adjustment-alert", 21, 11, alert);
  });

  it.each([
    { enabled: false, useLegacyMode: false, weightAdjustmentAlertEnabled: true },
    { enabled: true, useLegacyMode: true, weightAdjustmentAlertEnabled: true },
    { enabled: true, useLegacyMode: false, weightAdjustmentAlertEnabled: false },
  ])("does not queue when notification settings disable the path", async (settings) => {
    mocks.getSettings.mockResolvedValue(settings);

    await sendProviderWeightAdjustmentAlert(alert);

    expect(mocks.getBindings).not.toHaveBeenCalled();
    expect(mocks.addJob).not.toHaveBeenCalled();
  });

  it("contains queue failures so rule execution remains committed", async () => {
    mocks.addJob.mockRejectedValue(new Error("queue unavailable"));

    await expect(sendProviderWeightAdjustmentAlert(alert)).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(
      "[ProviderWeightAdjustment] failed to enqueue alert",
      expect.objectContaining({
        ruleId: 4,
        event: "fault",
        error: "queue unavailable",
      })
    );
  });
});
