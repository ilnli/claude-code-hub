import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { requireAuth } from "@/lib/api/v1/_shared/auth-middleware";
import { fromZodError } from "@/lib/api/v1/_shared/error-envelope";
import { ProblemJsonSchema } from "@/lib/api/v1/schemas/_common";
import {
  ClientVersionPolicyBulkCreateResponseSchema,
  ClientVersionPolicyClientTypeParamSchema,
  ClientVersionPolicyCreateSchema,
  ClientVersionPolicyListResponseSchema,
  ClientVersionPolicyOverrideSchema,
  ClientVersionPolicySchema,
  ClientVersionPolicyUpdateSchema,
} from "@/lib/api/v1/schemas/client-version-policies";
import {
  bulkCreateAutomaticClientVersionPolicies,
  createClientVersionPolicy,
  deleteClientVersionPolicy,
  listClientVersionPolicies,
  overrideClientVersionPolicy,
  updateClientVersionPolicy,
} from "./handlers";

export const clientVersionPoliciesRouter = new OpenAPIHono({
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
    description: "Invalid client version policy.",
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
    description: "Client version policy not found.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  409: {
    description: "Client version policy already exists.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
} as const;

clientVersionPoliciesRouter.openapi(
  createRoute({
    method: "get",
    path: "/client-version-policies",
    middleware: requireAuth("admin"),
    tags: ["Client Version Policies"],
    summary: "List client version policies",
    description: "Lists every explicit client version policy and its automatic baseline history.",
    "x-required-access": "admin",
    security,
    responses: {
      200: {
        description: "Client version policies.",
        content: { "application/json": { schema: ClientVersionPolicyListResponseSchema } },
      },
      ...problemResponses,
    },
  }),
  listClientVersionPolicies as never
);

clientVersionPoliciesRouter.openapi(
  createRoute({
    method: "post",
    path: "/client-version-policies",
    middleware: requireAuth("admin"),
    tags: ["Client Version Policies"],
    summary: "Create client version policy",
    description: "Creates a policy for an observed active client type.",
    "x-required-access": "admin",
    security,
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: ClientVersionPolicyCreateSchema } },
      },
    },
    responses: {
      201: {
        description: "Created client version policy.",
        content: { "application/json": { schema: ClientVersionPolicySchema } },
      },
      ...problemResponses,
    },
  }),
  createClientVersionPolicy as never
);

clientVersionPoliciesRouter.openapi(
  createRoute({
    method: "post",
    path: "/client-version-policies/bulk/automatic",
    middleware: requireAuth("admin"),
    tags: ["Client Version Policies"],
    summary: "Create automatic policies for all unconfigured active client types",
    description:
      "Creates automatic-baseline policies for every currently active unconfigured type.",
    "x-required-access": "admin",
    security,
    responses: {
      200: {
        description: "Created automatic policies.",
        content: {
          "application/json": { schema: ClientVersionPolicyBulkCreateResponseSchema },
        },
      },
      ...problemResponses,
    },
  }),
  bulkCreateAutomaticClientVersionPolicies as never
);

clientVersionPoliciesRouter.openapi(
  createRoute({
    method: "patch",
    path: "/client-version-policies/{clientType}",
    middleware: requireAuth("admin"),
    tags: ["Client Version Policies"],
    summary: "Update client version policy",
    description: "Replaces the mode and values of one client version policy.",
    "x-required-access": "admin",
    security,
    request: {
      params: ClientVersionPolicyClientTypeParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: ClientVersionPolicyUpdateSchema } },
      },
    },
    responses: {
      200: {
        description: "Updated client version policy.",
        content: { "application/json": { schema: ClientVersionPolicySchema } },
      },
      ...problemResponses,
    },
  }),
  updateClientVersionPolicy as never
);

clientVersionPoliciesRouter.openapi(
  createRoute({
    method: "post",
    path: "/client-version-policies/{clientType}/override",
    middleware: requireAuth("admin"),
    tags: ["Client Version Policies"],
    summary: "Convert an automatic policy to a fixed range",
    description: "Converts an automatic or lag policy into its confirmed fixed version range.",
    "x-required-access": "admin",
    security,
    request: {
      params: ClientVersionPolicyClientTypeParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: ClientVersionPolicyOverrideSchema } },
      },
    },
    responses: {
      200: {
        description: "Generated fixed client version range.",
        content: { "application/json": { schema: ClientVersionPolicySchema } },
      },
      ...problemResponses,
    },
  }),
  overrideClientVersionPolicy as never
);

clientVersionPoliciesRouter.openapi(
  createRoute({
    method: "delete",
    path: "/client-version-policies/{clientType}",
    middleware: requireAuth("admin"),
    tags: ["Client Version Policies"],
    summary: "Delete client version policy",
    description:
      "Deletes a policy so requests from this client type are no longer version-checked.",
    "x-required-access": "admin",
    security,
    request: { params: ClientVersionPolicyClientTypeParamSchema },
    responses: {
      204: { description: "Client version policy deleted." },
      ...problemResponses,
    },
  }),
  deleteClientVersionPolicy as never
);
