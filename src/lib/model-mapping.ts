import type { GlobalModelRedirectRule } from "@/types/model-mapping";
import type { Provider, ProviderModelRedirectRule } from "@/types/provider";
import { PROVIDER_RULE_LIMITS } from "./constants/provider.constants";
import {
  findMatchingProviderModelRedirectRule,
  matchesProviderModelRedirectRule,
  resolveProviderModelRedirectTarget,
} from "./provider-model-redirects";

const MAX_GLOBAL_MAPPING_STEPS = 32;

export interface ModelMappingStep {
  source: "provider" | "global";
  inputModel: string;
  outputModel: string;
  rule: ProviderModelRedirectRule;
  ruleIndex: number;
}

export type ModelMappingStopReason =
  | "no_match"
  | "provider_rule"
  | "unchanged"
  | "cycle"
  | "step_limit"
  | "model_length_limit";

export interface ModelMappingResult {
  originalModel: string;
  redirectedModel: string;
  steps: ModelMappingStep[];
  stopReason: ModelMappingStopReason;
}

export function resolveModelMapping(
  model: string,
  provider: Pick<Provider, "id" | "modelRedirects">,
  globalRules: ReadonlyArray<GlobalModelRedirectRule> = []
): ModelMappingResult {
  const result: ModelMappingResult = {
    originalModel: model,
    redirectedModel: model,
    steps: [],
    stopReason: "no_match",
  };
  if (!model) return result;

  // Provider rules keep their single-match behavior and override the entire global chain.
  const providerRule = findMatchingProviderModelRedirectRule(model, provider.modelRedirects);
  if (providerRule) {
    result.redirectedModel = resolveProviderModelRedirectTarget(model, providerRule);
    result.steps.push({
      source: "provider",
      inputModel: model,
      outputModel: result.redirectedModel,
      rule: providerRule,
      ruleIndex: provider.modelRedirects!.indexOf(providerRule),
    });
    result.stopReason = "provider_rule";
    return result;
  }

  const visited = new Set([model]);
  while (true) {
    const ruleIndex = globalRules.findIndex(
      (rule) =>
        !rule.excludedProviderIds.includes(provider.id) &&
        matchesProviderModelRedirectRule(result.redirectedModel, rule)
    );
    if (ruleIndex === -1) return result;
    if (result.steps.length >= MAX_GLOBAL_MAPPING_STEPS) {
      result.stopReason = "step_limit";
      return result;
    }

    const rule = globalRules[ruleIndex];
    const inputModel = result.redirectedModel;
    const outputModel = resolveProviderModelRedirectTarget(inputModel, rule);
    if (outputModel.length > PROVIDER_RULE_LIMITS.MAX_TEXT_LENGTH) {
      result.stopReason = "model_length_limit";
      return result;
    }
    if (outputModel !== inputModel && visited.has(outputModel)) {
      result.stopReason = "cycle";
      return result;
    }
    result.steps.push({
      source: "global",
      inputModel,
      outputModel,
      rule: { matchType: rule.matchType, source: rule.source, target: rule.target },
      ruleIndex,
    });
    result.redirectedModel = outputModel;
    if (outputModel === inputModel) {
      result.stopReason = "unchanged";
      return result;
    }
    visited.add(outputModel);
  }
}
