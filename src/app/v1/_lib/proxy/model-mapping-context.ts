import { getCachedSystemSettings } from "@/lib/config";
import { createModelMappingContext, type ModelMappingContext } from "@/lib/model-mapping";
import type { ProxySession } from "./session";

export function getRequestModelMappingContext(
  session?: ProxySession
): Promise<ModelMappingContext> {
  const load = async () => {
    const settings = await getCachedSystemSettings();
    const applyMappings =
      !settings.matchProviderModelsAfterMapping ||
      !session?.getEndpointPolicy().bypassForwarderPreprocessing;
    return createModelMappingContext(settings, applyMappings);
  };
  // The promise is also shared by hedge shadows via the existing session copy.
  return session ? (session.modelMappingContext ??= load()) : load();
}
