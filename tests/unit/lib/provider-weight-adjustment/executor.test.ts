import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publishCacheInvalidation: vi.fn(),
  claimRun: vi.fn(),
  clearFault: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  findRunByIdempotencyKey: vi.fn(),
  getPreview: vi.fn(),
  getRun: vi.fn(),
  loadSnapshot: vi.fn(),
  markWarning: vi.fn(),
  setFault: vi.fn(),
  sendAlert: vi.fn(),
}));

vi.mock("@/lib/cache/provider-cache", () => ({
  publishProviderCacheInvalidation: mocks.publishCacheInvalidation,
}));

vi.mock("@/repository/provider-weight-adjustment", () => ({
  claimProviderWeightAdjustmentRun: mocks.claimRun,
  clearProviderWeightAdjustmentFault: mocks.clearFault,
  completeProviderWeightAdjustmentRun: mocks.completeRun,
  failProviderWeightAdjustmentRun: mocks.failRun,
  findProviderWeightAdjustmentRunByIdempotencyKey: mocks.findRunByIdempotencyKey,
  getProviderWeightAdjustmentPreview: mocks.getPreview,
  getProviderWeightAdjustmentRun: mocks.getRun,
  loadProviderWeightAdjustmentRunSnapshot: mocks.loadSnapshot,
  markProviderWeightAdjustmentRunWarning: mocks.markWarning,
  ProviderWeightAdjustmentError: class extends Error {
    constructor(
      public readonly code: string,
      message: string
    ) {
      super(message);
    }
  },
  setProviderWeightAdjustmentFault: mocks.setFault,
}));

vi.mock("@/lib/provider-weight-adjustment/notifications", () => ({
  sendProviderWeightAdjustmentAlert: mocks.sendAlert,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn() },
}));

import { executeProviderWeightAdjustment } from "@/lib/provider-weight-adjustment/executor";

const rule = {
  id: 7,
  name: "Cost pool",
  description: null,
  providerType: "claude" as const,
  priority: 1,
  isEnabled: true,
  revision: 3,
  nextRunAt: new Date("2026-08-06T01:00:00.000Z"),
  activeRunId: 91,
  faultActive: false,
  faultKind: null,
  faultMessage: null,
  faultStartedAt: null,
  lastRunAt: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-06T00:00:00.000Z"),
  deletedAt: null,
};

const runningRun = {
  id: 91,
  ruleId: 7,
  trigger: "scheduled" as const,
  status: "running" as const,
  idempotencyKey: null,
  ruleName: "Cost pool",
  providerType: "claude" as const,
  priority: 1,
  ruleRevision: 3,
  summary: {
    memberCount: 0,
    participantCount: 0,
    changedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  },
  errorMessage: null,
  startedAt: new Date("2026-08-06T00:00:00.000Z"),
  completedAt: null,
  expiresAt: new Date("2026-08-13T00:00:00.000Z"),
};

const participants = [
  {
    providerId: 1,
    providerName: "Low cost",
    providerType: "claude" as const,
    priority: 1,
    isEnabled: true,
    costMultiplier: "1.0000",
    currentWeight: 50,
  },
  {
    providerId: 2,
    providerName: "High cost",
    providerType: "claude" as const,
    priority: 1,
    isEnabled: true,
    costMultiplier: "2.0000",
    currentWeight: 50,
  },
];

describe("executeProviderWeightAdjustment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRunByIdempotencyKey.mockResolvedValue(null);
    mocks.getPreview.mockResolvedValue({ rule, preview: { actionable: true } });
    mocks.claimRun.mockResolvedValue({ run: runningRun, rule, replay: false });
    mocks.loadSnapshot.mockResolvedValue({ rule, members: participants });
    mocks.completeRun.mockResolvedValue(undefined);
    mocks.failRun.mockResolvedValue(undefined);
    mocks.getRun.mockResolvedValue({ ...runningRun, status: "succeeded" });
    mocks.publishCacheInvalidation.mockResolvedValue(undefined);
    mocks.setFault.mockResolvedValue(false);
    mocks.clearFault.mockResolvedValue(false);
    mocks.markWarning.mockResolvedValue(undefined);
    mocks.sendAlert.mockResolvedValue(undefined);
  });

  it("requires an idempotency key before a manual run is claimed", async () => {
    await expect(
      executeProviderWeightAdjustment({ ruleId: 7, trigger: "manual" })
    ).rejects.toMatchObject({ code: "idempotency_key_required" });
    expect(mocks.claimRun).not.toHaveBeenCalled();
  });

  it("replays a manual run without creating another run", async () => {
    const replay = { ...runningRun, trigger: "manual" as const, status: "succeeded" as const };
    mocks.findRunByIdempotencyKey.mockResolvedValue(replay);

    await expect(
      executeProviderWeightAdjustment({
        ruleId: 7,
        trigger: "manual",
        idempotencyKey: "request-1",
      })
    ).resolves.toBe(replay);
    expect(mocks.getPreview).not.toHaveBeenCalled();
    expect(mocks.claimRun).not.toHaveBeenCalled();
  });

  it("rejects an invalid manual run before creating history or notifications", async () => {
    mocks.getPreview.mockResolvedValue({ rule, preview: { actionable: false } });

    await expect(
      executeProviderWeightAdjustment({
        ruleId: 7,
        trigger: "manual",
        idempotencyKey: "request-2",
      })
    ).rejects.toMatchObject({ code: "insufficient_participants" });
    expect(mocks.claimRun).not.toHaveBeenCalled();
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("returns a claim replay created by a concurrent request", async () => {
    const replay = { ...runningRun, trigger: "manual" as const, status: "succeeded" as const };
    mocks.claimRun.mockResolvedValue({ run: replay, rule, replay: true });

    await expect(
      executeProviderWeightAdjustment({
        ruleId: 7,
        trigger: "manual",
        idempotencyKey: "request-race",
      })
    ).resolves.toBe(replay);
    expect(mocks.loadSnapshot).not.toHaveBeenCalled();
  });

  it("commits changed providers, invalidates cache, and closes an old fault", async () => {
    mocks.clearFault.mockResolvedValue(true);

    await executeProviderWeightAdjustment({ ruleId: 7, trigger: "scheduled" });

    expect(mocks.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 91,
        expectedRevision: 3,
        status: "succeeded",
        summary: {
          memberCount: 2,
          participantCount: 2,
          changedCount: 2,
          skippedCount: 0,
          failedCount: 0,
        },
        changes: [
          expect.objectContaining({ providerId: 1, previousWeight: 50, nextWeight: 67 }),
          expect.objectContaining({ providerId: 2, previousWeight: 50, nextWeight: 33 }),
        ],
      })
    );
    expect(mocks.publishCacheInvalidation).toHaveBeenCalledOnce();
    expect(mocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ event: "recovery", ruleId: 7, runId: 91 })
    );
  });

  it("records a failed summary and opens one fault episode when the transaction fails", async () => {
    mocks.completeRun.mockRejectedValue(new Error("provider changed"));
    mocks.setFault.mockResolvedValue(true);
    mocks.getRun.mockResolvedValue({ ...runningRun, status: "failed" });

    await executeProviderWeightAdjustment({ ruleId: 7, trigger: "scheduled" });

    expect(mocks.failRun).toHaveBeenCalledWith(
      91,
      7,
      "provider changed",
      expect.any(Date),
      expect.arrayContaining([
        expect.objectContaining({ providerId: 1, outcome: "failed" }),
        expect.objectContaining({ providerId: 2, outcome: "failed" }),
      ]),
      {
        memberCount: 2,
        participantCount: 2,
        changedCount: 0,
        skippedCount: 0,
        failedCount: 2,
      }
    );
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fault", faultKind: "run_failed" })
    );
    expect(mocks.publishCacheInvalidation).not.toHaveBeenCalled();
  });

  it("does not repeat a notification while the same fault episode remains open", async () => {
    mocks.completeRun.mockRejectedValue(new Error("provider changed"));
    mocks.setFault.mockResolvedValue(false);
    mocks.getRun.mockResolvedValue({ ...runningRun, status: "failed" });

    await executeProviderWeightAdjustment({ ruleId: 7, trigger: "scheduled" });

    expect(mocks.setFault).toHaveBeenCalledOnce();
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("marks a committed run with a warning when cache invalidation fails", async () => {
    mocks.publishCacheInvalidation.mockRejectedValue(new Error("redis unavailable"));
    mocks.setFault.mockResolvedValue(true);

    await executeProviderWeightAdjustment({ ruleId: 7, trigger: "scheduled" });

    expect(mocks.markWarning).toHaveBeenCalledWith(91, "redis unavailable");
    expect(mocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fault", faultKind: "cache_invalidation_failed" })
    );
    expect(mocks.clearFault).not.toHaveBeenCalled();
  });

  it("stores a skipped scheduled run and faults when fewer than two participants remain", async () => {
    mocks.loadSnapshot.mockResolvedValue({ rule, members: participants.slice(0, 1) });
    mocks.setFault.mockResolvedValue(true);
    mocks.getRun.mockResolvedValue({ ...runningRun, status: "skipped" });

    await executeProviderWeightAdjustment({ ruleId: 7, trigger: "scheduled" });

    expect(mocks.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        changes: [],
        summary: {
          memberCount: 1,
          participantCount: 1,
          changedCount: 0,
          skippedCount: 1,
          failedCount: 0,
        },
      })
    );
    expect(mocks.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fault", faultKind: "insufficient_participants" })
    );
  });

  it("does not invalidate cache when every calculated weight is unchanged", async () => {
    mocks.loadSnapshot.mockResolvedValue({
      rule,
      members: participants.map((member) => ({
        ...member,
        costMultiplier: "1.0000",
        currentWeight: 50,
      })),
    });
    mocks.clearFault.mockResolvedValue(true);

    await executeProviderWeightAdjustment({ ruleId: 7, trigger: "scheduled" });

    expect(mocks.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [],
        summary: expect.objectContaining({ changedCount: 0 }),
      })
    );
    expect(mocks.publishCacheInvalidation).not.toHaveBeenCalled();
    expect(mocks.sendAlert).toHaveBeenCalledWith(expect.objectContaining({ event: "recovery" }));
  });

  it("fails an accepted run if its rule is deleted before the snapshot loads", async () => {
    mocks.loadSnapshot.mockResolvedValue(null);

    await expect(
      executeProviderWeightAdjustment({ ruleId: 7, trigger: "scheduled" })
    ).rejects.toMatchObject({ code: "rule_not_found" });
    expect(mocks.failRun).toHaveBeenCalledWith(
      91,
      7,
      "The rule was deleted after the run was accepted."
    );
  });
});
