import { describe, expect, test, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

type BatchUpdateRow = {
  id: number;
  providerVendorId: number | null;
  providerType: string;
  url: string;
};

function createDbMock(updatedRows: BatchUpdateRow[]) {
  const updateSetPayloads: Array<Record<string, unknown>> = [];

  const updateReturningMock = vi.fn(async () => updatedRows);
  const updateWhereMock = vi.fn(() => ({ returning: updateReturningMock }));
  const updateSetMock = vi.fn((payload: Record<string, unknown>) => {
    updateSetPayloads.push(payload);
    return { where: updateWhereMock };
  });
  const updateMock = vi.fn(() => ({ set: updateSetMock }));

  const insertReturningMock = vi.fn(async () => []);
  const insertOnConflictDoNothingMock = vi.fn(() => ({ returning: insertReturningMock }));
  const insertValuesMock = vi.fn(() => ({ onConflictDoNothing: insertOnConflictDoNothingMock }));
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));

  return {
    db: {
      update: updateMock,
      insert: insertMock,
    },
    mocks: {
      updateMock,
      updateWhereMock,
      updateSetPayloads,
      insertMock,
    },
  };
}

async function arrange(updatedRows: BatchUpdateRow[] = []) {
  vi.resetModules();

  const dbMock = createDbMock(updatedRows);

  vi.doMock("@/drizzle/db", () => ({ db: dbMock.db }));
  vi.doMock("@/lib/logger", () => ({
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  const { restoreProviderCostMultiplier, updateProvidersBatch, updateUpstreamBillingProbeResult } =
    await import("@/repository/provider");

  return {
    restoreProviderCostMultiplier,
    updateProvidersBatch,
    updateUpstreamBillingProbeResult,
    ...dbMock.mocks,
  };
}

describe("provider repository - updateProvidersBatch advanced fields", () => {
  const updatedRows: BatchUpdateRow[] = [
    {
      id: 11,
      providerVendorId: 100,
      providerType: "claude",
      url: "https://api-one.example.com/v1/messages",
    },
    {
      id: 22,
      providerVendorId: 100,
      providerType: "claude",
      url: "https://api-two.example.com/v1/messages",
    },
  ];

  test("updates modelRedirects for multiple providers", async () => {
    const { updateProvidersBatch, updateSetPayloads, updateMock, insertMock } =
      await arrange(updatedRows);
    const modelRedirects = {
      "claude-sonnet-4-5-20250929": "glm-4.6",
    };

    const result = await updateProvidersBatch([11, 22], { modelRedirects });

    expect(result).toBe(2);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateSetPayloads[0]).toEqual(
      expect.objectContaining({
        updatedAt: expect.any(Date),
        modelRedirects,
      })
    );
    expect(insertMock).not.toHaveBeenCalled();
  });

  test("updates allowedModels for multiple providers", async () => {
    const { updateProvidersBatch, updateSetPayloads } = await arrange(updatedRows);
    const allowedModels = ["claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805"];

    const result = await updateProvidersBatch([11, 22], { allowedModels });

    expect(result).toBe(2);
    expect(updateSetPayloads[0]).toEqual(
      expect.objectContaining({
        updatedAt: expect.any(Date),
        allowedModels,
      })
    );
  });

  test("updates anthropicThinkingBudgetPreference for multiple providers", async () => {
    const { updateProvidersBatch, updateSetPayloads } = await arrange(updatedRows);

    const result = await updateProvidersBatch([11, 22], {
      anthropicThinkingBudgetPreference: "4096",
    });

    expect(result).toBe(2);
    expect(updateSetPayloads[0]).toEqual(
      expect.objectContaining({
        updatedAt: expect.any(Date),
        anthropicThinkingBudgetPreference: "4096",
      })
    );
  });

  test("updates anthropicAdaptiveThinking for multiple providers", async () => {
    const { updateProvidersBatch, updateSetPayloads } = await arrange(updatedRows);
    const anthropicAdaptiveThinking = {
      effort: "high",
      modelMatchMode: "specific",
      models: ["claude-sonnet-4-5-20250929"],
    };

    const result = await updateProvidersBatch([11, 22], {
      anthropicAdaptiveThinking,
    });

    expect(result).toBe(2);
    expect(updateSetPayloads[0]).toEqual(
      expect.objectContaining({
        updatedAt: expect.any(Date),
        anthropicAdaptiveThinking,
      })
    );
  });

  test("updates upstream rate-follow fields for undo", async () => {
    const { updateProvidersBatch, updateSetPayloads } = await arrange(updatedRows);

    const result = await updateProvidersBatch([11, 22], {
      costMultiplier: "1.5000",
      rateFollowUpstream: true,
      rateDefaultMultiplier: "1.2000",
      rateMarkupType: "percent",
      rateMarkupValue: "0.1000",
    });

    expect(result).toBe(2);
    expect(updateSetPayloads[0]).toEqual(
      expect.objectContaining({
        costMultiplier: "1.5000",
        rateFollowUpstream: true,
        rateDefaultMultiplier: "1.2000",
        rateMarkupType: "percent",
        rateMarkupValue: "0.1000",
      })
    );
  });

  test("guards successful probe writes against concurrent provider changes", async () => {
    const { updateUpstreamBillingProbeResult, updateWhereMock } = await arrange([]);
    const expectedUpdatedAt = new Date("2026-08-02T12:00:00.000Z");

    const wrote = await updateUpstreamBillingProbeResult(
      11,
      {
        costMultiplier: 1.5,
        upstreamRateMultiplier: 1.4,
        syncedAt: new Date("2026-08-02T12:00:01.000Z"),
      },
      expectedUpdatedAt
    );

    expect(wrote).toBe(false);
    const query = new PgDialect().sqlToQuery(updateWhereMock.mock.calls[0]?.[0] as never);
    expect(query.sql).toContain('"providers"."rate_follow_upstream" = $2');
    expect(query.sql).toContain('"providers"."deleted_at" is null');
    expect(query.sql).toContain('"providers"."updated_at" >= $3');
    expect(query.sql).toContain('"providers"."updated_at" < $4');
    expect(query.params).toEqual([
      11,
      true,
      expectedUpdatedAt.toISOString(),
      "2026-08-02T12:00:00.001Z",
    ]);
  });

  test("guards fallback restores against concurrent provider changes", async () => {
    const { restoreProviderCostMultiplier, updateWhereMock } = await arrange([]);
    const expectedUpdatedAt = new Date("2026-08-02T12:00:00.000Z");

    const wrote = await restoreProviderCostMultiplier(11, 1.2, expectedUpdatedAt);

    expect(wrote).toBe(false);
    const query = new PgDialect().sqlToQuery(updateWhereMock.mock.calls[0]?.[0] as never);
    expect(query.sql).toContain('"providers"."rate_follow_upstream" = $2');
    expect(query.sql).toContain('"providers"."deleted_at" is null');
    expect(query.sql).toContain('"providers"."updated_at" >= $3');
    expect(query.sql).toContain('"providers"."updated_at" < $4');
    expect(query.params).toEqual([
      11,
      true,
      expectedUpdatedAt.toISOString(),
      "2026-08-02T12:00:00.001Z",
    ]);
  });

  test("does not include undefined advanced fields in set payload", async () => {
    const { updateProvidersBatch, updateSetPayloads } = await arrange(updatedRows);

    const result = await updateProvidersBatch([11, 22], {
      priority: 3,
      modelRedirects: undefined,
      allowedModels: undefined,
      anthropicThinkingBudgetPreference: undefined,
      anthropicAdaptiveThinking: undefined,
    });

    expect(result).toBe(2);
    expect(updateSetPayloads[0]).toEqual(
      expect.objectContaining({
        updatedAt: expect.any(Date),
        priority: 3,
      })
    );
    expect(updateSetPayloads[0]).not.toHaveProperty("modelRedirects");
    expect(updateSetPayloads[0]).not.toHaveProperty("allowedModels");
    expect(updateSetPayloads[0]).not.toHaveProperty("anthropicThinkingBudgetPreference");
    expect(updateSetPayloads[0]).not.toHaveProperty("anthropicAdaptiveThinking");
  });

  test("writes null advanced values to clear fields", async () => {
    const { updateProvidersBatch, updateSetPayloads } = await arrange(updatedRows);

    const result = await updateProvidersBatch([11, 22], {
      modelRedirects: null,
      allowedModels: null,
      anthropicThinkingBudgetPreference: null,
      anthropicAdaptiveThinking: null,
    });

    expect(result).toBe(2);
    expect(updateSetPayloads[0]).toEqual(
      expect.objectContaining({
        updatedAt: expect.any(Date),
        modelRedirects: null,
        allowedModels: null,
        anthropicThinkingBudgetPreference: null,
        anthropicAdaptiveThinking: null,
      })
    );
  });
});
