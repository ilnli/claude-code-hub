import { getCachedSystemSettings } from "@/lib/config";
import { createModelMappingContext, type ModelMappingContext } from "@/lib/model-mapping";
import { isResponseCompactEndpointPath } from "./endpoint-paths";
import type { EndpointPolicy } from "./endpoint-policy";
import type { ProxySession } from "./session";

export function shouldApplyModelMapping(
  session: ProxySession,
  policy: EndpointPolicy = session.getEndpointPolicy()
): boolean {
  return (
    !policy.bypassForwarderPreprocessing ||
    isResponseCompactEndpointPath(session.getManagedEndpoint?.() ?? "")
  );
}

export function getRequestModelMappingContext(
  session?: ProxySession
): Promise<ModelMappingContext> {
  const load = async () => {
    const settings = await getCachedSystemSettings();
    const applyMappings =
      !settings.matchProviderModelsAfterMapping || !session || shouldApplyModelMapping(session);
    return createModelMappingContext(settings, applyMappings);
  };
  // The promise is also shared by hedge shadows via the existing session copy.
  return session ? (session.modelMappingContext ??= load()) : load();
}
