import type { ProviderModelRedirectRule } from "@/types/provider";

export interface GlobalModelRedirectRule extends ProviderModelRedirectRule {
  excludedProviderIds: number[];
}
