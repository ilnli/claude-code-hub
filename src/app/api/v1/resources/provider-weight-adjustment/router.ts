import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requireAuth } from "@/lib/api/v1/_shared/auth-middleware";
import { fromZodError } from "@/lib/api/v1/_shared/error-envelope";
import { ProblemJsonSchema } from "@/lib/api/v1/schemas/_common";
import {
  ProviderWeightAdjustmentBulkResultSchema,
  ProviderWeightAdjustmentMembersSchema,
  ProviderWeightAdjustmentRuleCreateSchema,
  ProviderWeightAdjustmentRuleIdParamSchema,
  ProviderWeightAdjustmentRuleListSchema,
  ProviderWeightAdjustmentRuleSchema,
  ProviderWeightAdjustmentRuleUpdateSchema,
  ProviderWeightAdjustmentRunDetailListSchema,
  ProviderWeightAdjustmentRunIdParamSchema,
  ProviderWeightAdjustmentRunListSchema,
  ProviderWeightAdjustmentRunSchema,
  ProviderWeightAdjustmentRunsQuerySchema,
  ProviderWeightAdjustmentSettingsSchema,
} from "@/lib/api/v1/schemas/provider-weight-adjustment";
import {
  createRule,
  deleteRule,
  disableAllRules,
  disableRule,
  enableAllRules,
  enableRule,
  getRule,
  getSettings,
  listRules,
  listRunDetails,
  listRuns,
  replaceMembers,
  runRule,
  updateRule,
  updateSettings,
} from "./handlers";

export const providerWeightAdjustmentRouter = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) return fromZodError(result.error, new URL(c.req.url).pathname);
  },
});

const security: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
  { apiKeyAuth: [] },
];
const tag = ["Provider Weight Adjustment"];
const problems = {
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
    description: "Rule not found.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  409: {
    description: "Rule or membership conflict.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  422: {
    description: "Rule is not actionable.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
} as const;

providerWeightAdjustmentRouter.openapi(
  createRoute({
    method: "get",
    path: "/provider-weight-adjustment-rules",
    middleware: requireAuth("admin"),
    tags: tag,
    summary: "List provider weight adjustment rules",
    description: "Returns every rule with its current member eligibility and weight preview.",
    "x-required-access": "admin",
    security,
    responses: {
      200: {
        description: "Rules with current previews.",
        content: { "application/json": { schema: ProviderWeightAdjustmentRuleListSchema } },
      },
      ...problems,
    },
  }),
  listRules as never
);

providerWeightAdjustmentRouter.openapi(
  createRoute({
    method: "post",
    path: "/provider-weight-adjustment-rules",
    middleware: requireAuth("admin"),
    tags: tag,
    summary: "Create a provider weight adjustment rule",
    description: "Creates a rule for providers that share one provider type and global priority.",
    "x-required-access": "admin",
    security,
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: ProviderWeightAdjustmentRuleCreateSchema } },
      },
    },
    responses: {
      201: {
        description: "Created rule.",
        content: { "application/json": { schema: ProviderWeightAdjustmentRuleSchema } },
      },
      ...problems,
    },
  }),
  createRule as never
);

providerWeightAdjustmentRouter.openapi(
  createRoute({
    method: "get",
    path: "/provider-weight-adjustment-settings",
    middleware: requireAuth("admin"),
    tags: tag,
    summary: "Get the shared adjustment interval",
    description: "Returns the fixed interval used to schedule every enabled adjustment rule.",
    "x-required-access": "admin",
    security,
    responses: {
      200: {
        description: "Shared interval.",
        content: { "application/json": { schema: ProviderWeightAdjustmentSettingsSchema } },
      },
      ...problems,
    },
  }),
  getSettings as never
);

providerWeightAdjustmentRouter.openapi(
  createRoute({
    method: "put",
    path: "/provider-weight-adjustment-settings",
    middleware: requireAuth("admin"),
    tags: tag,
    summary: "Update the shared adjustment interval",
    description: "Reschedules every enabled rule from the update time without running it.",
    "x-required-access": "admin",
    security,
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: ProviderWeightAdjustmentSettingsSchema } },
      },
    },
    responses: {
      200: {
        description: "Updated shared interval.",
        content: { "application/json": { schema: ProviderWeightAdjustmentSettingsSchema } },
      },
      ...problems,
    },
  }),
  updateSettings as never
);

for (const [path, summary, description, handler] of [
  [
    "/provider-weight-adjustment-rules:enableAll",
    "Enable all actionable rules",
    "Enables every rule that currently has enough eligible members to run.",
    enableAllRules,
  ],
  [
    "/provider-weight-adjustment-rules:disableAll",
    "Disable all rules",
    "Disables every provider weight adjustment rule without deleting its configuration.",
    disableAllRules,
  ],
] as const) {
  providerWeightAdjustmentRouter.openapi(
    createRoute({
      method: "post",
      path,
      middleware: requireAuth("admin"),
      tags: tag,
      summary,
      description,
      "x-required-access": "admin",
      security,
      responses: {
        200: {
          description: "Bulk rule update result.",
          content: { "application/json": { schema: ProviderWeightAdjustmentBulkResultSchema } },
        },
        ...problems,
      },
    }),
    handler as never
  );
}

providerWeightAdjustmentRouter.openapi(
  createRoute({
    method: "get",
    path: "/provider-weight-adjustment-runs/{runId}/details",
    middleware: requireAuth("admin"),
    tags: tag,
    summary: "List provider weight adjustment run details",
    description: "Returns the changed, skipped, and failed provider rows recorded for one run.",
    "x-required-access": "admin",
    security,
    request: { params: ProviderWeightAdjustmentRunIdParamSchema },
    responses: {
      200: {
        description: "Changed, skipped and failed provider details.",
        content: { "application/json": { schema: ProviderWeightAdjustmentRunDetailListSchema } },
      },
      ...problems,
    },
  }),
  listRunDetails as never
);

providerWeightAdjustmentRouter.openapi(
  createRoute({
    method: "get",
    path: "/provider-weight-adjustment-rules/{id}",
    middleware: requireAuth("admin"),
    tags: tag,
    summary: "Get a provider weight adjustment rule",
    description: "Returns one rule with its members and current calculated weight preview.",
    "x-required-access": "admin",
    security,
    request: { params: ProviderWeightAdjustmentRuleIdParamSchema },
    responses: {
      200: {
        description: "Rule with current preview.",
        content: { "application/json": { schema: ProviderWeightAdjustmentRuleSchema } },
      },
      ...problems,
    },
  }),
  getRule as never
);

providerWeightAdjustmentRouter.openapi(
  createRoute({
    method: "patch",
    path: "/provider-weight-adjustment-rules/{id}",
    middleware: requireAuth("admin"),
    tags: tag,
    summary: "Update a provider weight adjustment rule",
    description: "Updates rule metadata or scope while preserving its explicitly selected members.",
    "x-required-access": "admin",
    security,
    request: {
      params: ProviderWeightAdjustmentRuleIdParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: ProviderWeightAdjustmentRuleUpdateSchema } },
      },
    },
    responses: {
      200: {
        description: "Updated rule.",
        content: { "application/json": { schema: ProviderWeightAdjustmentRuleSchema } },
      },
      ...problems,
    },
  }),
  updateRule as never
);

providerWeightAdjustmentRouter.openapi(
  createRoute({
    method: "delete",
    path: "/provider-weight-adjustment-rules/{id}",
    middleware: requireAuth("admin"),
    tags: tag,
    summary: "Delete a provider weight adjustment rule",
    description: "Soft-deletes a rule and stops it from participating in future scheduled runs.",
    "x-required-access": "admin",
    security,
    request: { params: ProviderWeightAdjustmentRuleIdParamSchema },
    responses: { 204: { description: "Rule deleted." }, ...problems },
  }),
  deleteRule as never
);

providerWeightAdjustmentRouter.openapi(
  createRoute({
    method: "put",
    path: "/provider-weight-adjustment-rules/{id}/members",
    middleware: requireAuth("admin"),
    tags: tag,
    summary: "Replace rule members",
    description: "Replaces all members after validating their provider type and global priority.",
    "x-required-access": "admin",
    security,
    request: {
      params: ProviderWeightAdjustmentRuleIdParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: ProviderWeightAdjustmentMembersSchema } },
      },
    },
    responses: {
      200: {
        description: "Updated rule and preview.",
        content: { "application/json": { schema: ProviderWeightAdjustmentRuleSchema } },
      },
      ...problems,
    },
  }),
  replaceMembers as never
);

for (const [path, summary, description, handler] of [
  [
    "/provider-weight-adjustment-rules/{id}/enable",
    "Enable a rule",
    "Enables an actionable rule and schedules its next fixed-interval run.",
    enableRule,
  ],
  [
    "/provider-weight-adjustment-rules/{id}/disable",
    "Disable a rule",
    "Disables a rule without deleting its members or run history.",
    disableRule,
  ],
] as const) {
  providerWeightAdjustmentRouter.openapi(
    createRoute({
      method: "post",
      path,
      middleware: requireAuth("admin"),
      tags: tag,
      summary,
      description,
      "x-required-access": "admin",
      security,
      request: { params: ProviderWeightAdjustmentRuleIdParamSchema },
      responses: {
        200: {
          description: "Updated rule.",
          content: { "application/json": { schema: ProviderWeightAdjustmentRuleSchema } },
        },
        ...problems,
      },
    }),
    handler as never
  );
}

providerWeightAdjustmentRouter.openapi(
  createRoute({
    method: "post",
    path: "/provider-weight-adjustment-rules/{id}/run",
    middleware: requireAuth("admin"),
    tags: tag,
    summary: "Run a provider weight adjustment rule now",
    description: "Requires an Idempotency-Key header and synchronously rejects invalid rules.",
    "x-required-access": "admin",
    security,
    request: {
      params: ProviderWeightAdjustmentRuleIdParamSchema,
      headers: z.object({ "Idempotency-Key": z.string().min(1).max(200) }),
    },
    responses: {
      200: {
        description: "Completed or replayed run.",
        content: { "application/json": { schema: ProviderWeightAdjustmentRunSchema } },
      },
      ...problems,
    },
  }),
  runRule as never
);

providerWeightAdjustmentRouter.openapi(
  createRoute({
    method: "get",
    path: "/provider-weight-adjustment-rules/{id}/runs",
    middleware: requireAuth("admin"),
    tags: tag,
    summary: "List provider weight adjustment rule runs",
    description: "Returns up to seven days of execution history for the selected rule.",
    "x-required-access": "admin",
    security,
    request: {
      params: ProviderWeightAdjustmentRuleIdParamSchema,
      query: ProviderWeightAdjustmentRunsQuerySchema,
    },
    responses: {
      200: {
        description: "Seven-day run history.",
        content: { "application/json": { schema: ProviderWeightAdjustmentRunListSchema } },
      },
      ...problems,
    },
  }),
  listRuns as never
);
