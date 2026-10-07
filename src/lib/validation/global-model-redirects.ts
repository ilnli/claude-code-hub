import { z } from "zod";
import { PROVIDER_RULE_LIMITS } from "@/lib/constants/provider.constants";
import { PROVIDER_MODEL_REDIRECT_RULE_SCHEMA } from "@/lib/provider-model-redirect-schema";

export const GlobalModelRedirectRuleSchema = PROVIDER_MODEL_REDIRECT_RULE_SCHEMA.safeExtend({
  excludedProviderIds: z.array(z.number().int().positive()).default([]),
});

export const GlobalModelRedirectRulesSchema = z
  .array(GlobalModelRedirectRuleSchema)
  .max(PROVIDER_RULE_LIMITS.MAX_ITEMS);
