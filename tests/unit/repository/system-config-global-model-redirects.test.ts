import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  missingColumn: false,
  missingMatchingColumn: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/drizzle/db", () => ({
  db: {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        orderBy: () => ({
          limit: async () => {
            if (database.missingMatchingColumn && "matchProviderModelsAfterMapping" in selection)
              throw { code: "42703" };
            if (database.missingColumn && "globalModelRedirects" in selection)
              throw { code: "42703" };
            return [database.row];
          },
        }),
      }),
    }),
    update: () => ({
      set: (updates: Record<string, unknown>) => ({
        where: () => ({
          returning: async (selection: Record<string, unknown>) => {
            if (
              database.missingMatchingColumn &&
              ("matchProviderModelsAfterMapping" in selection ||
                "matchProviderModelsAfterMapping" in updates)
            )
              throw { code: "42703" };
            if (
              database.missingColumn &&
              ("globalModelRedirects" in selection || "globalModelRedirects" in updates)
            )
              throw { code: "42703" };
            database.row = { ...database.row, ...updates };
            return [database.row];
          },
        }),
      }),
    }),
  },
}));
import { getSystemSettings, updateSystemSettings } from "@/repository/system-config";

describe("global mappings persistence", () => {
  beforeEach(() => {
    database.row = { id: 1, siteTitle: "CC Hub" };
    database.missingColumn = false;
    database.missingMatchingColumn = false;
  });
  it("defaults matching to false and persists both enabled and disabled settings", async () => {
    expect((await getSystemSettings()).matchProviderModelsAfterMapping).toBe(false);
    await updateSystemSettings({ matchProviderModelsAfterMapping: true });
    await updateSystemSettings({ siteTitle: "Unrelated" });
    expect((await getSystemSettings()).matchProviderModelsAfterMapping).toBe(true);
    await updateSystemSettings({ matchProviderModelsAfterMapping: false });
    expect((await getSystemSettings()).matchProviderModelsAfterMapping).toBe(false);
  });
  it("uses false on an old database without the matching switch column", async () => {
    database.missingMatchingColumn = true;
    expect((await getSystemSettings()).matchProviderModelsAfterMapping).toBe(false);
    const updated = await updateSystemSettings({ siteTitle: "Old database" });
    expect(updated.siteTitle).toBe("Old database");
    expect(updated.matchProviderModelsAfterMapping).toBe(false);
  });
  it("round-trips rules, preserves them on unrelated updates, and clears them explicitly", async () => {
    const rules = [
      {
        matchType: "exact" as const,
        source: "client",
        target: "upstream",
        excludedProviderIds: [2],
      },
    ];
    await updateSystemSettings({ globalModelRedirects: rules });
    expect((await getSystemSettings()).globalModelRedirects).toEqual(rules);
    await updateSystemSettings({ siteTitle: "Updated" });
    expect((await getSystemSettings()).globalModelRedirects).toEqual(rules);
    await updateSystemSettings({ globalModelRedirects: [] });
    expect((await getSystemSettings()).globalModelRedirects).toEqual([]);
  });
  it("reads and updates old database rows when the new column is absent", async () => {
    database.missingColumn = true;
    expect((await getSystemSettings()).globalModelRedirects).toEqual([]);
    const updated = await updateSystemSettings({ siteTitle: "Old database" });
    expect(updated.siteTitle).toBe("Old database");
    expect(updated.globalModelRedirects).toEqual([]);
  });
});
