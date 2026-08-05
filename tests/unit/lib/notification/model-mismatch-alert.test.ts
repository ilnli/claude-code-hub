import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getNotificationSettings: vi.fn(),
  getEnabledBindingsByType: vi.fn(),
  getRedisClient: vi.fn(),
  addNotificationJobForTarget: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: mocks.getRedisClient,
}));

vi.mock("@/repository/notifications", () => ({
  getNotificationSettings: mocks.getNotificationSettings,
}));

vi.mock("@/repository/notification-bindings", () => ({
  getEnabledBindingsByType: mocks.getEnabledBindingsByType,
}));

vi.mock("@/lib/notification/notification-queue", () => ({
  addNotificationJobForTarget: mocks.addNotificationJobForTarget,
}));

import {
  aggregateModelMismatchOccurrence,
  MODEL_MISMATCH_ALERT_COOLDOWN_MINUTES,
  recordModelMismatch,
} from "@/lib/notification/model-mismatch-alert";

describe("model mismatch alert aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNotificationSettings.mockResolvedValue({
      enabled: true,
      useLegacyMode: false,
      modelMismatchAlertEnabled: true,
    });
    mocks.getEnabledBindingsByType.mockResolvedValue([
      { id: 11, targetId: 101 },
      { id: 12, targetId: 102 },
    ]);
    mocks.addNotificationJobForTarget.mockResolvedValue(undefined);
  });

  test("first occurrence is sent immediately with the current mismatch", async () => {
    const redis = { eval: vi.fn().mockResolvedValue([1, "1", ""]) };
    const occurredAt = new Date("2026-08-05T10:00:00.000Z");

    const result = await aggregateModelMismatchOccurrence(redis, {
      providerId: 7,
      providerName: "Provider A",
      requestedModel: "requested-a",
      actualResponseModel: "actual-a",
      occurredAt,
    });

    expect(result).toEqual({
      shouldNotify: true,
      payload: {
        providerId: 7,
        providerName: "Provider A",
        occurrenceCount: 1,
        mismatches: [{ requestedModel: "requested-a", actualResponseModel: "actual-a" }],
        windowStart: occurredAt.toISOString(),
        windowEnd: occurredAt.toISOString(),
        cooldownMinutes: MODEL_MISMATCH_ALERT_COOLDOWN_MINUTES,
        generatedAt: occurredAt.toISOString(),
      },
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      4,
      "model-mismatch-alert:{7}:cooldown",
      "model-mismatch-alert:{7}:pending-count",
      "model-mismatch-alert:{7}:pending-pairs",
      "model-mismatch-alert:{7}:last-sent-at",
      JSON.stringify({ requestedModel: "requested-a", actualResponseModel: "actual-a" }),
      occurredAt.toISOString(),
      600
    );
    const luaScript = redis.eval.mock.calls[0]?.[0];
    expect(luaScript).not.toContain('redis.call("EXPIRE", pending_count_key');
    expect(luaScript).not.toContain('redis.call("EXPIRE", pending_pairs_key');
    expect(luaScript).toContain('redis.call("SET", last_sent_key, now_iso)');
  });

  test("occurrences inside cooldown are only accumulated", async () => {
    const redis = { eval: vi.fn().mockResolvedValue([0, "3"]) };

    await expect(
      aggregateModelMismatchOccurrence(redis, {
        providerId: 7,
        providerName: "Provider A",
        requestedModel: "requested-a",
        actualResponseModel: "actual-a",
      })
    ).resolves.toEqual({ shouldNotify: false });
  });

  test("next notification includes the count and all unique model pairs", async () => {
    const previousSentAt = "2026-08-05T10:00:00.000Z";
    const occurredAt = new Date("2026-08-05T10:10:01.000Z");
    const redis = {
      eval: vi
        .fn()
        .mockResolvedValue([
          1,
          "5",
          previousSentAt,
          JSON.stringify({ requestedModel: "requested-a", actualResponseModel: "actual-a" }),
          JSON.stringify({ requestedModel: "requested-b", actualResponseModel: "actual-b" }),
          "malformed",
        ]),
    };

    const result = await aggregateModelMismatchOccurrence(redis, {
      providerId: 7,
      providerName: "Provider A",
      requestedModel: "requested-b",
      actualResponseModel: "actual-b",
      occurredAt,
    });

    expect(result.payload).toMatchObject({
      occurrenceCount: 5,
      windowStart: previousSentAt,
      windowEnd: occurredAt.toISOString(),
      mismatches: [
        { requestedModel: "requested-a", actualResponseModel: "actual-a" },
        { requestedModel: "requested-b", actualResponseModel: "actual-b" },
      ],
    });
  });

  test("enabled alerts enqueue the same aggregate for every binding", async () => {
    const redis = { eval: vi.fn().mockResolvedValue([1, "1", ""]) };
    mocks.getRedisClient.mockReturnValue(redis);

    await recordModelMismatch({
      providerId: 7,
      providerName: " Provider A ",
      requestedModel: " requested-a ",
      actualResponseModel: " actual-a ",
    });

    expect(mocks.getEnabledBindingsByType).toHaveBeenCalledWith("model_mismatch_alert");
    expect(mocks.addNotificationJobForTarget).toHaveBeenCalledTimes(2);
    expect(mocks.addNotificationJobForTarget).toHaveBeenNthCalledWith(
      1,
      "model-mismatch-alert",
      101,
      11,
      expect.objectContaining({
        providerId: 7,
        occurrenceCount: 1,
        mismatches: [{ requestedModel: "requested-a", actualResponseModel: "actual-a" }],
      })
    );
  });

  test("equal models, exemptions, disabled settings, and missing Redis do not enqueue", async () => {
    await recordModelMismatch({
      providerId: 7,
      providerName: "Provider A",
      requestedModel: "same",
      actualResponseModel: "same",
    });
    await recordModelMismatch({
      providerId: 7,
      providerName: "Provider A",
      requestedModel: "a",
      actualResponseModel: "b",
      modelMismatchAlertExempt: true,
    });
    expect(mocks.getNotificationSettings).not.toHaveBeenCalled();

    mocks.getNotificationSettings.mockResolvedValueOnce({
      enabled: false,
      useLegacyMode: false,
      modelMismatchAlertEnabled: true,
    });
    await recordModelMismatch({
      providerId: 7,
      providerName: "Provider A",
      requestedModel: "a",
      actualResponseModel: "b",
    });

    mocks.getRedisClient.mockReturnValueOnce(null);
    await recordModelMismatch({
      providerId: 7,
      providerName: "Provider A",
      requestedModel: "a",
      actualResponseModel: "c",
    });

    expect(mocks.addNotificationJobForTarget).not.toHaveBeenCalled();
  });
});
