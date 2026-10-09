import { describe, expect, test } from "vitest";
import { createModelMappingContext, resolveModelMapping } from "@/lib/model-mapping";
import type { GlobalModelRedirectRule } from "@/types/model-mapping";
import type { Provider } from "@/types/provider";

const provider: Pick<Provider, "id" | "modelRedirects"> = { id: 1, modelRedirects: null };
const rule = (
  source: string,
  target: string,
  overrides: Partial<GlobalModelRedirectRule> = {}
): GlobalModelRedirectRule => ({
  matchType: "exact",
  source,
  target,
  excludedProviderIds: [],
  ...overrides,
});

describe("request model mapping context", () => {
  test("defaults matching to the requested model while still resolving redirects for forwarding", () => {
    const context = createModelMappingContext({ globalModelRedirects: [rule("A", "B")] });
    expect(context.matchProviderModelsAfterMapping).toBe(false);
    expect(context.resolve(provider, "A").redirectedModel).toBe("B");
  });

  test("reuses a provider/model resolution without leaking across models or providers", () => {
    const context = createModelMappingContext({
      matchProviderModelsAfterMapping: true,
      globalModelRedirects: [rule("A", "B", { excludedProviderIds: [2] })],
    });
    const first = context.resolve(provider, "A");
    expect(context.resolve(provider, "A")).toBe(first);
    expect(context.resolve({ ...provider, id: 2 }, "A").redirectedModel).toBe("A");
    expect(context.resolve(provider, "Z").redirectedModel).toBe("Z");
    expect(context.resolve(provider, "A").redirectedModel).toBe("B");
    expect(context.matchProviderModelsAfterMapping).toBe(true);
  });

  test("raw passthrough uses the actual unchanged model even when mapped matching is enabled", () => {
    const context = createModelMappingContext(
      {
        matchProviderModelsAfterMapping: true,
        globalModelRedirects: [rule("A", "B")],
      },
      false
    );
    expect(context.matchProviderModelsAfterMapping).toBe(false);
    expect(context.resolve(provider, "A")).toMatchObject({
      originalModel: "A",
      redirectedModel: "A",
      steps: [],
      stopReason: "no_match",
    });
  });
});

describe("resolveModelMapping", () => {
  test("keeps the model when no rule matches", () => {
    expect(resolveModelMapping("A", provider, [rule("B", "C")])).toEqual({
      originalModel: "A",
      redirectedModel: "A",
      steps: [],
      stopReason: "no_match",
    });
    expect(resolveModelMapping("A", provider).redirectedModel).toBe("A");
    expect(resolveModelMapping("", provider, [rule("", "B")]).steps).toEqual([]);
  });

  test("chains global rules even when the next rule occurs earlier in the list", () => {
    const result = resolveModelMapping("A", provider, [rule("B", "C"), rule("A", "B")]);
    expect(result.redirectedModel).toBe("C");
    expect(result.steps).toMatchObject([
      { source: "global", inputModel: "A", outputModel: "B", ruleIndex: 1 },
      { source: "global", inputModel: "B", outputModel: "C", ruleIndex: 0 },
    ]);
    expect(result.stopReason).toBe("no_match");
  });

  test("provider rule wins and does not chain through either rule set", () => {
    const result = resolveModelMapping(
      "A",
      { ...provider, modelRedirects: [rule("A", "D"), rule("D", "E")] },
      [rule("A", "B"), rule("B", "C"), rule("D", "F")]
    );
    expect(result.redirectedModel).toBe("D");
    expect(result.stopReason).toBe("provider_rule");
    expect(result.steps).toMatchObject([
      { source: "provider", inputModel: "A", outputModel: "D", ruleIndex: 0 },
    ]);
  });

  test("an explicit provider identity mapping suppresses global redirects", () => {
    const result = resolveModelMapping("A", { ...provider, modelRedirects: [rule("A", "A")] }, [
      rule("A", "B"),
    ]);
    expect(result.redirectedModel).toBe("A");
    expect(result.stopReason).toBe("provider_rule");
    expect(result.steps).toHaveLength(1);
  });

  test("a provider rule takes precedence when reached through the global chain", () => {
    const result = resolveModelMapping("A", { ...provider, modelRedirects: [rule("B", "D")] }, [
      rule("A", "B"),
      rule("B", "C"),
    ]);
    expect(result.redirectedModel).toBe("D");
    expect(result.stopReason).toBe("provider_rule");
    expect(result.steps).toMatchObject([
      { source: "global", inputModel: "A", outputModel: "B" },
      { source: "provider", inputModel: "B", outputModel: "D" },
    ]);
  });

  test("global chains can end in a provider regex mapping without restarting the chain", () => {
    const result = resolveModelMapping(
      "A",
      {
        ...provider,
        modelRedirects: [rule("^alias-(.+)$", "upstream-$1", { matchType: "regex" })],
      },
      [rule("A", "B"), rule("B", "alias-fast"), rule("upstream-fast", "unused")]
    );
    expect(result.redirectedModel).toBe("upstream-fast");
    expect(result.steps.map((step) => step.source)).toEqual(["global", "global", "provider"]);
  });

  test("exclusions apply per rule and at every step", () => {
    const rules = [rule("A", "B"), rule("B", "C", { excludedProviderIds: [1] })];
    expect(resolveModelMapping("A", provider, rules).redirectedModel).toBe("B");
    expect(resolveModelMapping("A", { ...provider, id: 999 }, rules).redirectedModel).toBe("C");
    expect(
      resolveModelMapping("A", provider, [rule("A", "B", { excludedProviderIds: [1] })]).steps
    ).toEqual([]);
  });

  test("takes the first eligible matching rule", () => {
    const result = resolveModelMapping("A", provider, [
      rule("A", "ignored", { excludedProviderIds: [1] }),
      rule("A", "B"),
      rule("A", "C"),
    ]);
    expect(result.redirectedModel).toBe("B");
    expect(result.steps[0].ruleIndex).toBe(1);
  });

  test.each([
    ["prefix", "claude-", "claude-opus"],
    ["suffix", "-fast", "gpt-fast"],
    ["contains", "sonnet", "claude-sonnet-4"],
  ] as const)("supports %s matching in a global chain", (matchType, source, model) => {
    expect(
      resolveModelMapping(model, provider, [rule(source, "B", { matchType }), rule("B", "C")])
        .redirectedModel
    ).toBe("C");
  });

  test("expands regex captures before finding the next match", () => {
    const result = resolveModelMapping("gpt-5-fast", provider, [
      rule("^(.+)-fast$", "$1", { matchType: "regex" }),
      rule("gpt-5", "actual"),
    ]);
    expect(result.redirectedModel).toBe("actual");
    expect(result.steps[0].outputModel).toBe("gpt-5");
  });

  test("preserves model spelling, including literal dollar signs", () => {
    const result = resolveModelMapping("gpt-$&", provider, [
      rule("^gpt-(.+)$", "test-$1", { matchType: "regex" }),
    ]);
    expect(result.redirectedModel).toBe("test-$&");
    expect(resolveModelMapping("a", provider, [rule("A", "B")]).redirectedModel).toBe("a");
  });

  test("stops a global identity mapping without calling it a cycle", () => {
    const result = resolveModelMapping("A", provider, [rule("A", "A"), rule("A", "B")]);
    expect(result.redirectedModel).toBe("A");
    expect(result.stopReason).toBe("unchanged");
    expect(result.steps).toHaveLength(1);
  });

  test("stops before revisiting a model and retains the last safe result", () => {
    const result = resolveModelMapping("A", provider, [rule("A", "B"), rule("B", "A")]);
    expect(result.redirectedModel).toBe("B");
    expect(result.steps).toHaveLength(1);
    expect(result.stopReason).toBe("cycle");
  });

  test("bounds a regex chain that never repeats a model", () => {
    const result = resolveModelMapping("A", provider, [
      rule("^(.*)$", "$1x", { matchType: "regex" }),
    ]);
    expect(result.stopReason).toBe("step_limit");
    expect(result.steps).toHaveLength(32);
    expect(result.redirectedModel).toBe(`A${"x".repeat(32)}`);
  });

  test("allows a chain that naturally finishes exactly at the step limit", () => {
    const rules = Array.from({ length: 32 }, (_, index) => rule(`m${index}`, `m${index + 1}`));
    const result = resolveModelMapping("m0", provider, rules);
    expect(result.redirectedModel).toBe("m32");
    expect(result.stopReason).toBe("no_match");
  });

  test("bounds exponential capture expansion before it produces a huge model", () => {
    const result = resolveModelMapping("x".repeat(2048), provider, [
      rule("^(.*)$", "$1$1", { matchType: "regex" }),
    ]);
    expect(result.redirectedModel).toHaveLength(4096);
    expect(result.steps).toHaveLength(1);
    expect(result.stopReason).toBe("model_length_limit");
  });
});
