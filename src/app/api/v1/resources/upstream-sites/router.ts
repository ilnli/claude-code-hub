import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { requireAuth } from "@/lib/api/v1/_shared/auth-middleware";
import { fromZodError } from "@/lib/api/v1/_shared/error-envelope";
import { ProblemJsonSchema } from "@/lib/api/v1/schemas/_common";
import {
  UpstreamSiteConfigSchema,
  UpstreamSiteIdParamSchema,
  UpstreamSiteListResponseSchema,
  UpstreamSitePatTestResponseSchema,
  UpstreamSitePatTestSchema,
  UpstreamSiteSchema,
} from "@/lib/api/v1/schemas/upstream-sites";
import {
  deleteUpstreamSite,
  listUpstreamSites,
  testUpstreamSitePat,
  updateUpstreamSite,
} from "./handlers";

export const upstreamSitesRouter = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) return fromZodError(result.error, new URL(c.req.url).pathname);
  },
});

const security: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
  { apiKeyAuth: [] },
];
const problemResponses = {
  400: {
    description: "Invalid request.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  401: {
    description: "Authentication required.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  403: {
    description: "Admin access required.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  404: {
    description: "Upstream site not found.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  409: {
    description: "Upstream site is still in use.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
} as const;

upstreamSitesRouter.openapi(
  createRoute({
    method: "get",
    path: "/upstream-sites",
    middleware: requireAuth("admin"),
    tags: ["Upstream Sites"],
    summary: "List upstream sites",
    description: "Lists domain-aggregated upstream sites without exposing PAT values.",
    "x-required-access": "admin",
    security,
    responses: {
      200: {
        description: "Upstream sites.",
        content: { "application/json": { schema: UpstreamSiteListResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  listUpstreamSites as never
);

upstreamSitesRouter.openapi(
  createRoute({
    method: "patch",
    path: "/upstream-sites/{id}",
    middleware: requireAuth("admin"),
    tags: ["Upstream Sites"],
    summary: "Update upstream site probe configuration",
    description: "Updates the target, write-only PAT, and proxy policy for an upstream site.",
    "x-required-access": "admin",
    security,
    request: {
      params: UpstreamSiteIdParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: UpstreamSiteConfigSchema } },
      },
    },
    responses: {
      200: {
        description: "Updated upstream site.",
        content: { "application/json": { schema: UpstreamSiteSchema } },
      },
      ...problemResponses,
    },
  }),
  updateUpstreamSite as never
);

upstreamSitesRouter.openapi(
  createRoute({
    method: "post",
    path: "/upstream-sites/{id}/pat:test",
    middleware: requireAuth("admin"),
    tags: ["Upstream Sites"],
    summary: "Test an upstream site PAT",
    description: "Validates a saved or draft PAT and target without changing Provider rates.",
    "x-required-access": "admin",
    security,
    request: {
      params: UpstreamSiteIdParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: UpstreamSitePatTestSchema } },
      },
    },
    responses: {
      200: {
        description: "PAT test result.",
        content: { "application/json": { schema: UpstreamSitePatTestResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  testUpstreamSitePat as never
);

upstreamSitesRouter.openapi(
  createRoute({
    method: "delete",
    path: "/upstream-sites/{id}",
    middleware: requireAuth("admin"),
    tags: ["Upstream Sites"],
    summary: "Delete an empty upstream site",
    description: "Deletes an upstream site only when it has no active Providers.",
    "x-required-access": "admin",
    security,
    request: { params: UpstreamSiteIdParamSchema },
    responses: { 204: { description: "Upstream site deleted." }, ...problemResponses },
  }),
  deleteUpstreamSite as never
);
