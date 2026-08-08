import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requireAuth } from "@/lib/api/v1/_shared/auth-middleware";
import { fromZodError } from "@/lib/api/v1/_shared/error-envelope";
import { ProblemJsonSchema } from "@/lib/api/v1/schemas/_common";
import {
  RechargeAdminOrderListSchema,
  RechargeAdminOrderQuerySchema,
  RechargeAdminReasonSchema,
  RechargeAvailabilitySchema,
  RechargeOrderCreateSchema,
  RechargeOrderIdParamSchema,
  RechargeOrderListSchema,
  RechargeOrderSchema,
  RechargePaymentConfigSchema,
  RechargePaymentConfigTestSchema,
  RechargePaymentConfigUpdateSchema,
} from "@/lib/api/v1/schemas/recharge";
import {
  alipayRechargeNotify,
  cancelMyRechargeOrder,
  cancelRechargeOrderAdminHandler,
  closeRechargeOrderAdminHandler,
  confirmRechargeOrderAdminHandler,
  createMyRechargeOrder,
  getMyRechargeAvailability,
  getMyRechargeOrder,
  getRechargeConfigAdmin,
  getRechargeOrderAdminHandler,
  listMyRechargeOrders,
  listRechargeOrdersAdminHandler,
  retryRechargeOrderAdminHandler,
  testRechargeConfigAdmin,
  updateRechargeConfigAdmin,
} from "./handlers";

export const rechargeRouter = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) return fromZodError(result.error, new URL(c.req.url).pathname);
  },
});

const security = [{ cookieAuth: [] }, { bearerAuth: [] }, { apiKeyAuth: [] }];
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
    description: "Access denied.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  409: {
    description: "Order state conflict.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
  422: {
    description: "Recharge request rejected.",
    content: { "application/problem+json": { schema: ProblemJsonSchema } },
  },
} as const;

function registerJsonRoute(options: {
  method: "get" | "post" | "put";
  path: string;
  tier: "read" | "admin";
  summary: string;
  description?: string;
  responseSchema: z.ZodType;
  request?: Record<string, unknown>;
  handler: (c: never) => Promise<Response>;
}) {
  rechargeRouter.openapi(
    createRoute({
      method: options.method,
      path: options.path,
      middleware: requireAuth(options.tier),
      tags: ["Recharge"],
      summary: options.summary,
      description: options.description ?? options.summary,
      "x-required-access": options.tier,
      security,
      ...(options.request ? { request: options.request } : {}),
      responses: {
        200: {
          description: "Success.",
          content: { "application/json": { schema: options.responseSchema } },
        },
        ...problems,
      },
    } as never),
    options.handler as never
  );
}

registerJsonRoute({
  method: "get",
  path: "/recharge/availability",
  tier: "read",
  summary: "Get recharge availability",
  responseSchema: RechargeAvailabilitySchema,
  handler: getMyRechargeAvailability as never,
});
registerJsonRoute({
  method: "get",
  path: "/recharge/orders",
  tier: "read",
  summary: "List current key recharge orders",
  responseSchema: RechargeOrderListSchema,
  handler: listMyRechargeOrders as never,
});
registerJsonRoute({
  method: "post",
  path: "/recharge/orders",
  tier: "read",
  summary: "Create recharge order",
  responseSchema: RechargeOrderSchema,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: RechargeOrderCreateSchema } },
    },
  },
  handler: createMyRechargeOrder as never,
});
registerJsonRoute({
  method: "get",
  path: "/recharge/orders/{orderId}",
  tier: "read",
  summary: "Get current key recharge order",
  responseSchema: RechargeOrderSchema,
  request: { params: RechargeOrderIdParamSchema },
  handler: getMyRechargeOrder as never,
});
registerJsonRoute({
  method: "post",
  path: "/recharge/orders/{orderId}:cancel",
  tier: "read",
  summary: "Cancel pending recharge order",
  responseSchema: RechargeOrderSchema,
  request: { params: RechargeOrderIdParamSchema },
  handler: cancelMyRechargeOrder as never,
});

registerJsonRoute({
  method: "get",
  path: "/recharge/config",
  tier: "admin",
  summary: "Get Alipay recharge configuration",
  responseSchema: RechargePaymentConfigSchema,
  handler: getRechargeConfigAdmin as never,
});
registerJsonRoute({
  method: "put",
  path: "/recharge/config",
  tier: "admin",
  summary: "Create a new Alipay recharge configuration version",
  responseSchema: RechargePaymentConfigSchema,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: RechargePaymentConfigUpdateSchema } },
    },
  },
  handler: updateRechargeConfigAdmin as never,
});
registerJsonRoute({
  method: "post",
  path: "/recharge/config:test",
  tier: "admin",
  summary: "Test Alipay recharge configuration",
  responseSchema: RechargePaymentConfigTestSchema,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: RechargePaymentConfigUpdateSchema } },
    },
  },
  handler: testRechargeConfigAdmin as never,
});
registerJsonRoute({
  method: "get",
  path: "/recharge/admin/orders",
  tier: "admin",
  summary: "List recharge orders",
  responseSchema: RechargeAdminOrderListSchema,
  request: { query: RechargeAdminOrderQuerySchema },
  handler: listRechargeOrdersAdminHandler as never,
});
registerJsonRoute({
  method: "get",
  path: "/recharge/admin/orders/{orderId}",
  tier: "admin",
  summary: "Get recharge order",
  responseSchema: RechargeOrderSchema,
  request: { params: RechargeOrderIdParamSchema },
  handler: getRechargeOrderAdminHandler as never,
});
for (const action of [
  ["confirm", confirmRechargeOrderAdminHandler],
  ["cancel", cancelRechargeOrderAdminHandler],
  ["close", closeRechargeOrderAdminHandler],
] as const) {
  registerJsonRoute({
    method: "post",
    path: `/recharge/admin/orders/{orderId}:${action[0]}`,
    tier: "admin",
    summary: `${action[0]} recharge order`,
    responseSchema: RechargeOrderSchema,
    request: {
      params: RechargeOrderIdParamSchema,
      body: {
        required: true,
        content: { "application/json": { schema: RechargeAdminReasonSchema } },
      },
    },
    handler: action[1] as never,
  });
}
registerJsonRoute({
  method: "post",
  path: "/recharge/admin/orders/{orderId}:retry",
  tier: "admin",
  summary: "Retry recharge settlement",
  responseSchema: RechargeOrderSchema,
  request: { params: RechargeOrderIdParamSchema },
  handler: retryRechargeOrderAdminHandler as never,
});

rechargeRouter.openapi(
  createRoute({
    method: "post",
    path: "/recharge/alipay/notify",
    tags: ["Recharge"],
    summary: "Alipay asynchronous notification",
    description: "Accepts and verifies Alipay asynchronous payment notifications.",
    "x-required-access": "public",
    responses: {
      200: {
        description: "Notification accepted.",
        content: { "text/plain": { schema: z.string() } },
      },
      400: {
        description: "Notification rejected.",
        content: { "text/plain": { schema: z.string() } },
      },
    },
  }),
  alipayRechargeNotify as never
);
