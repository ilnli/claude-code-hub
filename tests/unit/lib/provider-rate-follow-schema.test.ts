import { describe, expect, it } from "vitest";
import {
  ProviderCreateSchema,
  ProviderSummarySchema,
  ProviderUpdateSchema as ProviderV1UpdateSchema,
} from "@/lib/api/v1/schemas/providers";
import { CreateProviderSchema, UpdateProviderSchema } from "@/lib/validation/schemas";

const baseCreateInput = {
  name: "upstream",
  url: "https://upstream.example.com/v1",
  key: "sk-test",
};

describe("provider upstream-rate-follow validation", () => {
  it("defaults follow/markup fields to off on create", () => {
    const parsed = CreateProviderSchema.parse(baseCreateInput);
    expect(parsed.rate_follow_upstream).toBe(false);
    expect(parsed.rate_markup_type).toBe("none");
    expect(parsed.rate_markup_value).toBe(0);
    expect(parsed.rate_default_multiplier).toBeUndefined();
  });

  it("accepts enabling follow with an explicit default multiplier", () => {
    const parsed = CreateProviderSchema.parse({
      ...baseCreateInput,
      rate_follow_upstream: true,
      rate_default_multiplier: 1.2,
      rate_markup_type: "percent",
      rate_markup_value: 0.1,
    });
    expect(parsed.rate_follow_upstream).toBe(true);
    expect(parsed.rate_default_multiplier).toBe(1.2);
    expect(parsed.rate_markup_type).toBe("percent");
    expect(parsed.rate_markup_value).toBe(0.1);
  });

  it("accepts enabling follow without explicit default (cost_multiplier fallback)", () => {
    // cost_multiplier 在 create schema 中默认 1.0，action 层会复制为默认倍率
    const parsed = CreateProviderSchema.parse({
      ...baseCreateInput,
      rate_follow_upstream: true,
    });
    expect(parsed.rate_follow_upstream).toBe(true);
    expect(parsed.cost_multiplier).toBe(1.0);
  });

  it("rejects invalid markup type and out-of-range values", () => {
    expect(() =>
      CreateProviderSchema.parse({ ...baseCreateInput, rate_markup_type: "bogus" })
    ).toThrow();
    expect(() =>
      CreateProviderSchema.parse({ ...baseCreateInput, rate_markup_value: -0.5 })
    ).toThrow();
    expect(() =>
      CreateProviderSchema.parse({ ...baseCreateInput, rate_markup_value: 101 })
    ).toThrow();
    expect(() =>
      CreateProviderSchema.parse({ ...baseCreateInput, rate_default_multiplier: 0 })
    ).toThrow();
  });

  it("allows partial updates on update schema", () => {
    const parsed = UpdateProviderSchema.parse({ rate_follow_upstream: false });
    expect(parsed.rate_follow_upstream).toBe(false);
    expect(parsed.rate_markup_type).toBeUndefined();

    const parsed2 = UpdateProviderSchema.parse({
      rate_follow_upstream: true,
      rate_markup_type: "fixed",
      rate_markup_value: 0.01,
    });
    expect(parsed2.rate_markup_type).toBe("fixed");
    expect(parsed2.rate_markup_value).toBe(0.01);
  });

  it("accepts rate-follow fields in strict V1 create and update schemas", () => {
    const rateFields = {
      rate_follow_upstream: true,
      rate_default_multiplier: 1.2,
      rate_markup_type: "percent" as const,
      rate_markup_value: 0.1,
    };

    expect(ProviderCreateSchema.safeParse({ ...baseCreateInput, ...rateFields }).success).toBe(
      true
    );
    expect(ProviderV1UpdateSchema.safeParse(rateFields).success).toBe(true);
  });

  it("defaults probe type to sub2api and newapi_group to null on create", () => {
    const parsed = CreateProviderSchema.parse(baseCreateInput);
    expect(parsed.rate_upstream_type).toBe("sub2api");
    expect(parsed.newapi_group).toBeNull();
  });

  it("accepts newapi probe type with a group name; rejects unknown probe types", () => {
    const parsed = CreateProviderSchema.parse({
      ...baseCreateInput,
      rate_follow_upstream: true,
      rate_default_multiplier: 1.0,
      rate_upstream_type: "newapi",
      newapi_group: "vip",
    });
    expect(parsed.rate_upstream_type).toBe("newapi");
    expect(parsed.newapi_group).toBe("vip");

    expect(() =>
      CreateProviderSchema.parse({ ...baseCreateInput, rate_upstream_type: "oneapi" })
    ).toThrow();
    // 分组名最长 64 字符
    expect(() =>
      CreateProviderSchema.parse({ ...baseCreateInput, newapi_group: "g".repeat(65) })
    ).toThrow();
  });

  it("allows clearing newapi_group on update", () => {
    const parsed = UpdateProviderSchema.parse({ rate_upstream_type: "newapi", newapi_group: null });
    expect(parsed.rate_upstream_type).toBe("newapi");
    expect(parsed.newapi_group).toBeNull();
  });

  it("accepts probe-type fields in strict V1 create and update schemas", () => {
    const probeFields = { rate_upstream_type: "newapi" as const, newapi_group: "vip" };
    expect(ProviderCreateSchema.safeParse({ ...baseCreateInput, ...probeFields }).success).toBe(
      true
    );
    expect(ProviderV1UpdateSchema.safeParse(probeFields).success).toBe(true);
  });

  it("exposes probe-type state in the V1 provider response schema", () => {
    expect(Object.keys(ProviderSummarySchema.shape)).toEqual(
      expect.arrayContaining(["rateUpstreamType", "newapiGroup", "newapiDetectedGroup"])
    );
  });
});
