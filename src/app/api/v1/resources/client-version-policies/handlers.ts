import type { Context } from "hono";
import type { ActionResult } from "@/actions/types";
import { callAction } from "@/lib/api/v1/_shared/action-bridge";
import {
  createProblemResponse,
  fromZodError,
  publicActionErrorDetail,
} from "@/lib/api/v1/_shared/error-envelope";
import { parseHonoJsonBody } from "@/lib/api/v1/_shared/request-body";
import {
  createdResponse,
  jsonResponse,
  noContentResponse,
} from "@/lib/api/v1/_shared/response-helpers";
import {
  ClientVersionPolicyClientTypeParamSchema,
  ClientVersionPolicyCreateSchema,
  ClientVersionPolicyOverrideSchema,
  ClientVersionPolicyUpdateSchema,
} from "@/lib/api/v1/schemas/client-version-policies";

export async function listClientVersionPolicies(c: Context): Promise<Response> {
  const actions = await import("@/actions/client-version-policies");
  const result = await callAction(c, actions.listClientVersionPolicies, [], c.get("auth"));
  if (!result.ok) return actionError(c, result);
  return jsonResponse({ items: result.data });
}

export async function createClientVersionPolicy(c: Context): Promise<Response> {
  const body = await parseHonoJsonBody(c, ClientVersionPolicyCreateSchema);
  if (!body.ok) return body.response;
  const actions = await import("@/actions/client-version-policies");
  const result = await callAction(
    c,
    actions.createClientVersionPolicy,
    [body.data.clientType, body.data.policy] as never[],
    c.get("auth")
  );
  if (!result.ok) return actionError(c, result);
  return createdResponse(
    result.data,
    `/api/v1/client-version-policies/${encodeURIComponent(result.data.clientType)}`
  );
}

export async function updateClientVersionPolicy(c: Context): Promise<Response> {
  const params = parseClientType(c);
  if (params instanceof Response) return params;
  const body = await parseHonoJsonBody(c, ClientVersionPolicyUpdateSchema);
  if (!body.ok) return body.response;
  const actions = await import("@/actions/client-version-policies");
  const result = await callAction(
    c,
    actions.updateClientVersionPolicy,
    [params.clientType, body.data] as never[],
    c.get("auth")
  );
  if (!result.ok) return actionError(c, result);
  return jsonResponse(result.data);
}

export async function overrideClientVersionPolicy(c: Context): Promise<Response> {
  const params = parseClientType(c);
  if (params instanceof Response) return params;
  const body = await parseHonoJsonBody(c, ClientVersionPolicyOverrideSchema);
  if (!body.ok) return body.response;
  const actions = await import("@/actions/client-version-policies");
  const result = await callAction(
    c,
    actions.overrideClientVersionPolicy,
    [params.clientType, body.data.selectedVersion] as never[],
    c.get("auth")
  );
  if (!result.ok) return actionError(c, result);
  return jsonResponse(result.data);
}

export async function deleteClientVersionPolicy(c: Context): Promise<Response> {
  const params = parseClientType(c);
  if (params instanceof Response) return params;
  const actions = await import("@/actions/client-version-policies");
  const result = await callAction(
    c,
    actions.deleteClientVersionPolicy,
    [params.clientType] as never[],
    c.get("auth")
  );
  if (!result.ok) return actionError(c, result);
  return noContentResponse();
}

export async function bulkCreateAutomaticClientVersionPolicies(c: Context): Promise<Response> {
  const actions = await import("@/actions/client-version-policies");
  const result = await callAction(
    c,
    actions.bulkCreateAutomaticClientVersionPolicies,
    [],
    c.get("auth")
  );
  if (!result.ok) return actionError(c, result);
  return jsonResponse(result.data);
}

function parseClientType(c: Context): { clientType: string } | Response {
  const result = ClientVersionPolicyClientTypeParamSchema.safeParse({
    clientType: c.req.param("clientType"),
  });
  return result.success ? result.data : fromZodError(result.error, new URL(c.req.url).pathname);
}

function actionError(c: Context, result: Extract<ActionResult<unknown>, { ok: false }>): Response {
  const errorCode = result.errorCode ?? "client_version_policy.action_failed";
  const status =
    errorCode === "auth.forbidden"
      ? 403
      : errorCode === "POLICY_NOT_FOUND"
        ? 404
        : errorCode === "POLICY_ALREADY_EXISTS"
          ? 409
          : 400;
  return createProblemResponse({
    status,
    instance: new URL(c.req.url).pathname,
    errorCode,
    errorParams: result.errorParams,
    detail: publicActionErrorDetail(status),
  });
}
