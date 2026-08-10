import type { Context } from "hono";
import type { ActionResult } from "@/actions/types";
import { callAction } from "@/lib/api/v1/_shared/action-bridge";
import {
  createProblemResponse,
  fromZodError,
  publicActionErrorDetail,
} from "@/lib/api/v1/_shared/error-envelope";
import { parseHonoJsonBody } from "@/lib/api/v1/_shared/request-body";
import { jsonResponse, noContentResponse } from "@/lib/api/v1/_shared/response-helpers";
import {
  UpstreamSiteConfigSchema,
  UpstreamSiteIdParamSchema,
  UpstreamSitePatTestSchema,
} from "@/lib/api/v1/schemas/upstream-sites";

function parseSiteId(c: Context): number | Response {
  const parsed = UpstreamSiteIdParamSchema.safeParse({ id: c.req.param("id") });
  return parsed.success ? parsed.data.id : fromZodError(parsed.error, new URL(c.req.url).pathname);
}

export async function listUpstreamSites(c: Context): Promise<Response> {
  const actions = await import("@/actions/upstream-sites");
  const result = await callAction(c, actions.getUpstreamSites, [], c.get("auth"));
  if (!result.ok) return actionError(c, result);
  return jsonResponse({ items: result.data.sites });
}

export async function updateUpstreamSite(c: Context): Promise<Response> {
  const siteId = parseSiteId(c);
  if (siteId instanceof Response) return siteId;
  const body = await parseHonoJsonBody(c, UpstreamSiteConfigSchema);
  if (!body.ok) return body.response;

  const actions = await import("@/actions/upstream-sites");
  const result = await callAction(
    c,
    actions.saveUpstreamSiteConfig,
    [{ siteId, ...body.data }] as never[],
    c.get("auth")
  );
  if (!result.ok) return actionError(c, result);
  return jsonResponse(result.data.site);
}

export async function testUpstreamSitePat(c: Context): Promise<Response> {
  const siteId = parseSiteId(c);
  if (siteId instanceof Response) return siteId;
  const body = await parseHonoJsonBody(c, UpstreamSitePatTestSchema);
  if (!body.ok) return body.response;

  const actions = await import("@/actions/upstream-sites");
  const result = await callAction(
    c,
    actions.testUpstreamSitePat,
    [{ siteId, ...body.data }] as never[],
    c.get("auth")
  );
  if (!result.ok) return actionError(c, result);
  return jsonResponse(result.data);
}

export async function deleteUpstreamSite(c: Context): Promise<Response> {
  const siteId = parseSiteId(c);
  if (siteId instanceof Response) return siteId;
  const actions = await import("@/actions/upstream-sites");
  const result = await callAction(
    c,
    actions.removeUpstreamSite,
    [siteId] as never[],
    c.get("auth")
  );
  if (!result.ok) return actionError(c, result);
  return noContentResponse();
}

function actionError(c: Context, result: Extract<ActionResult<unknown>, { ok: false }>): Response {
  const notFound = result.errorCode === "upstream_site.not_found";
  const conflict = result.errorCode === "upstream_site.in_use";
  const status = notFound ? 404 : conflict ? 409 : result.errorCode === "unauthorized" ? 403 : 400;
  return createProblemResponse({
    status,
    instance: new URL(c.req.url).pathname,
    errorCode: result.errorCode ?? "upstream_site.action_failed",
    errorParams: result.errorParams,
    detail: publicActionErrorDetail(status),
  });
}
