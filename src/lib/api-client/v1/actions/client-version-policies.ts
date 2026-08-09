import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  toActionResult,
  toVoidActionResult,
  unwrapItems,
} from "./_compat";

export function listClientVersionPolicies() {
  return toActionResult(
    apiGet<{ items?: unknown[] }>("/api/v1/client-version-policies").then(unwrapItems)
  );
}

export function createClientVersionPolicy(clientType: string, policy: unknown) {
  return toActionResult(apiPost("/api/v1/client-version-policies", { clientType, policy }));
}

export function updateClientVersionPolicy(clientType: string, policy: unknown) {
  return toActionResult(
    apiPatch(`/api/v1/client-version-policies/${encodeURIComponent(clientType)}`, policy)
  );
}

export function overrideClientVersionPolicy(clientType: string, selectedVersion: string) {
  return toActionResult(
    apiPost(`/api/v1/client-version-policies/${encodeURIComponent(clientType)}/override`, {
      selectedVersion,
    })
  );
}

export function deleteClientVersionPolicy(clientType: string) {
  return toVoidActionResult(
    apiDelete(`/api/v1/client-version-policies/${encodeURIComponent(clientType)}`)
  );
}

export function bulkCreateAutomaticClientVersionPolicies() {
  return toActionResult(apiPost("/api/v1/client-version-policies/bulk/automatic"));
}
