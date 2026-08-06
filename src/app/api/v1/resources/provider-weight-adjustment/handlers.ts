import type { Context } from "hono";
import type { ActionResult } from "@/actions/types";
import { callAction } from "@/lib/api/v1/_shared/action-bridge";
import { createProblemResponse, fromZodError } from "@/lib/api/v1/_shared/error-envelope";
import { parseHonoJsonBody } from "@/lib/api/v1/_shared/request-body";
import {
  createdResponse,
  jsonResponse,
  noContentResponse,
} from "@/lib/api/v1/_shared/response-helpers";
import {
  ProviderWeightAdjustmentMembersSchema,
  ProviderWeightAdjustmentRuleCreateSchema,
  ProviderWeightAdjustmentRuleIdParamSchema,
  ProviderWeightAdjustmentRuleUpdateSchema,
  ProviderWeightAdjustmentRunIdParamSchema,
  ProviderWeightAdjustmentRunsQuerySchema,
  ProviderWeightAdjustmentSettingsSchema,
} from "@/lib/api/v1/schemas/provider-weight-adjustment";

function parseRuleId(c: Context): number | Response {
  const parsed = ProviderWeightAdjustmentRuleIdParamSchema.safeParse({ id: c.req.param("id") });
  return parsed.success ? parsed.data.id : fromZodError(parsed.error, new URL(c.req.url).pathname);
}

function actionError(c: Context, result: Extract<ActionResult<unknown>, { ok: false }>): Response {
  const conflicts = new Set([
    "rule_name_conflict",
    "provider_already_managed",
    "scope_locked_by_members",
    "rule_has_active_run",
    "run_overlap",
  ]);
  const status =
    result.errorCode === "rule_not_found"
      ? 404
      : conflicts.has(result.errorCode ?? "")
        ? 409
        : result.errorCode === "insufficient_participants"
          ? 422
          : result.errorCode === "auth.forbidden"
            ? 403
            : 400;
  return createProblemResponse({
    status,
    instance: new URL(c.req.url).pathname,
    errorCode: result.errorCode ?? "provider_weight_adjustment.operation_failed",
    errorParams: result.errorParams,
    detail:
      status === 404
        ? "The requested resource was not found."
        : "The request could not be completed.",
  });
}

export async function listRules(c: Context): Promise<Response> {
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.listProviderWeightAdjustmentRulesAction,
    [],
    c.get("auth")
  );
  return result.ok ? jsonResponse({ items: result.data }) : actionError(c, result);
}

export async function getRule(c: Context): Promise<Response> {
  const id = parseRuleId(c);
  if (id instanceof Response) return id;
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.getProviderWeightAdjustmentRuleAction,
    [id] as never[],
    c.get("auth")
  );
  return result.ok ? jsonResponse(result.data) : actionError(c, result);
}

export async function createRule(c: Context): Promise<Response> {
  const body = await parseHonoJsonBody(c, ProviderWeightAdjustmentRuleCreateSchema);
  if (!body.ok) return body.response;
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.createProviderWeightAdjustmentRuleAction,
    [body.data] as never[],
    c.get("auth")
  );
  return result.ok
    ? createdResponse(result.data, `/api/v1/provider-weight-adjustment-rules/${result.data.id}`)
    : actionError(c, result);
}

export async function updateRule(c: Context): Promise<Response> {
  const id = parseRuleId(c);
  if (id instanceof Response) return id;
  const body = await parseHonoJsonBody(c, ProviderWeightAdjustmentRuleUpdateSchema);
  if (!body.ok) return body.response;
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.updateProviderWeightAdjustmentRuleAction,
    [id, body.data] as never[],
    c.get("auth")
  );
  return result.ok ? jsonResponse(result.data) : actionError(c, result);
}

export async function deleteRule(c: Context): Promise<Response> {
  const id = parseRuleId(c);
  if (id instanceof Response) return id;
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.deleteProviderWeightAdjustmentRuleAction,
    [id] as never[],
    c.get("auth")
  );
  return result.ok ? noContentResponse() : actionError(c, result);
}

export async function replaceMembers(c: Context): Promise<Response> {
  const id = parseRuleId(c);
  if (id instanceof Response) return id;
  const body = await parseHonoJsonBody(c, ProviderWeightAdjustmentMembersSchema);
  if (!body.ok) return body.response;
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.replaceProviderWeightAdjustmentMembersAction,
    [id, body.data.providerIds] as never[],
    c.get("auth")
  );
  return result.ok ? jsonResponse(result.data) : actionError(c, result);
}

async function setEnabled(c: Context, enabled: boolean): Promise<Response> {
  const id = parseRuleId(c);
  if (id instanceof Response) return id;
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.setProviderWeightAdjustmentRuleEnabledAction,
    [id, enabled] as never[],
    c.get("auth")
  );
  return result.ok ? jsonResponse(result.data) : actionError(c, result);
}

export function enableRule(c: Context): Promise<Response> {
  return setEnabled(c, true);
}

export function disableRule(c: Context): Promise<Response> {
  return setEnabled(c, false);
}

async function setAllEnabled(c: Context, enabled: boolean): Promise<Response> {
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.setAllProviderWeightAdjustmentRulesEnabledAction,
    [enabled] as never[],
    c.get("auth")
  );
  return result.ok ? jsonResponse(result.data) : actionError(c, result);
}

export function enableAllRules(c: Context): Promise<Response> {
  return setAllEnabled(c, true);
}

export function disableAllRules(c: Context): Promise<Response> {
  return setAllEnabled(c, false);
}

export async function runRule(c: Context): Promise<Response> {
  const id = parseRuleId(c);
  if (id instanceof Response) return id;
  const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return createProblemResponse({
      status: 400,
      instance: new URL(c.req.url).pathname,
      errorCode: "idempotency_key_required",
      detail: "A valid Idempotency-Key header is required.",
    });
  }
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.runProviderWeightAdjustmentRuleAction,
    [id, idempotencyKey] as never[],
    c.get("auth")
  );
  return result.ok ? jsonResponse(result.data) : actionError(c, result);
}

export async function listRuns(c: Context): Promise<Response> {
  const id = parseRuleId(c);
  if (id instanceof Response) return id;
  const query = ProviderWeightAdjustmentRunsQuerySchema.safeParse(c.req.query());
  if (!query.success) return fromZodError(query.error, new URL(c.req.url).pathname);
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.listProviderWeightAdjustmentRunsAction,
    [id, query.data.limit] as never[],
    c.get("auth")
  );
  return result.ok ? jsonResponse({ items: result.data }) : actionError(c, result);
}

export async function listRunDetails(c: Context): Promise<Response> {
  const parsed = ProviderWeightAdjustmentRunIdParamSchema.safeParse({
    runId: c.req.param("runId"),
  });
  if (!parsed.success) return fromZodError(parsed.error, new URL(c.req.url).pathname);
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.listProviderWeightAdjustmentRunDetailsAction,
    [parsed.data.runId] as never[],
    c.get("auth")
  );
  return result.ok ? jsonResponse({ items: result.data }) : actionError(c, result);
}

export async function getSettings(c: Context): Promise<Response> {
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.getProviderWeightAdjustmentSettingsAction,
    [],
    c.get("auth")
  );
  return result.ok ? jsonResponse(result.data) : actionError(c, result);
}

export async function updateSettings(c: Context): Promise<Response> {
  const body = await parseHonoJsonBody(c, ProviderWeightAdjustmentSettingsSchema);
  if (!body.ok) return body.response;
  const actions = await import("@/actions/provider-weight-adjustment");
  const result = await callAction(
    c,
    actions.setProviderWeightAdjustmentSettingsAction,
    [body.data] as never[],
    c.get("auth")
  );
  return result.ok ? jsonResponse(result.data) : actionError(c, result);
}
