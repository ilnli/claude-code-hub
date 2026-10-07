import { describe, expect, it, vi } from "vitest";
import { UpdateSystemSettingsSchema } from "@/lib/validation/schemas";
import { SystemSettingsUpdateSchema } from "@/lib/api/v1/schemas/system-config";
import { toSystemSettings } from "@/repository/_shared/transformers";

vi.mock("server-only", () => ({}));

const rule = { matchType: "exact", source: "client", target: "upstream", excludedProviderIds: [] };

describe.each([
  ["action", UpdateSystemSettingsSchema],
  ["REST", SystemSettingsUpdateSchema],
] as const)("global model mapping %s validation", (_name, schema) => {
  it.each([true, false])("preserves the provider matching switch %s", (enabled) => {
    expect(
      schema.parse({ matchProviderModelsAfterMapping: enabled }).matchProviderModelsAfterMapping
    ).toBe(enabled);
  });
  it("rejects a non-boolean provider matching switch and preserves omission", () => {
    expect(schema.safeParse({ matchProviderModelsAfterMapping: "true" }).success).toBe(false);
    expect(schema.parse({}).matchProviderModelsAfterMapping).toBeUndefined();
  });
  it("applies a rule to all providers when exclusions are omitted", () => {
    expect(
      schema.parse({
        globalModelRedirects: [{ matchType: "exact", source: "client", target: "upstream" }],
      }).globalModelRedirects
    ).toEqual([rule]);
  });
  it("keeps ordered rules and exclusions and trims model names", () => {
    const rules = [
      { ...rule, source: " client ", excludedProviderIds: [2, 9] },
      { ...rule, matchType: "prefix", source: "upstream", target: "final" },
    ];
    expect(schema.parse({ globalModelRedirects: rules }).globalModelRedirects).toEqual([
      { ...rules[0], source: "client" },
      rules[1],
    ]);
  });
  it("preserves explicit clearing while partial updates omit mappings", () => {
    expect(schema.parse({ globalModelRedirects: [] }).globalModelRedirects).toEqual([]);
    expect(schema.parse({}).globalModelRedirects).toBeUndefined();
  });
  it.each([
    { source: " " },
    { target: "" },
    { matchType: "glob" },
    { matchType: "regex", source: "[" },
    { matchType: "regex", source: "(a+)+$" },
    { excludedProviderIds: [0] },
    { excludedProviderIds: [-1] },
    { excludedProviderIds: [1.5] },
    { excludedProviderIds: ["1"] },
  ])("rejects invalid rules %j", (invalid) => {
    expect(schema.safeParse({ globalModelRedirects: [{ ...rule, ...invalid }] }).success).toBe(
      false
    );
  });
});

describe("global mapping settings defaults", () => {
  it("defaults old rows to no mappings and returns persisted exclusions", () => {
    expect(toSystemSettings(undefined).matchProviderModelsAfterMapping).toBe(false);
    expect(
      toSystemSettings({ matchProviderModelsAfterMapping: true }).matchProviderModelsAfterMapping
    ).toBe(true);
    expect(
      toSystemSettings({ matchProviderModelsAfterMapping: false }).matchProviderModelsAfterMapping
    ).toBe(false);
    expect(toSystemSettings(undefined).globalModelRedirects).toEqual([]);
    expect(toSystemSettings({ id: 1 }).globalModelRedirects).toEqual([]);
    expect(
      toSystemSettings({ globalModelRedirects: [{ ...rule, excludedProviderIds: [7] }] })
        .globalModelRedirects
    ).toEqual([{ ...rule, excludedProviderIds: [7] }]);
    expect(toSystemSettings({ globalModelRedirects: [] }).globalModelRedirects).toEqual([]);
  });
});
