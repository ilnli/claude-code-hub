import type { Context } from "hono";
import type { ResolvedAuth } from "@/lib/api/v1/_shared/auth-middleware";
import { createProblemResponse, fromZodError } from "@/lib/api/v1/_shared/error-envelope";
import { parseHonoJsonBody } from "@/lib/api/v1/_shared/request-body";
import { jsonResponse } from "@/lib/api/v1/_shared/response-helpers";
import {
  RechargeAdminOrderQuerySchema,
  RechargeAdminReasonSchema,
  RechargeOrderCreateSchema,
  RechargeOrderIdParamSchema,
  RechargePaymentConfigUpdateSchema,
} from "@/lib/api/v1/schemas/recharge";
import { getRequestContext } from "@/lib/audit/request-context";
import { createAuditLogAsync } from "@/repository/audit-log";
import {
  adminCancelRechargeOrder,
  adminCloseRechargeOrder,
  adminConfirmRechargeOrder,
  adminRetryRechargeOrder,
  cancelRechargeOrderForKey,
  createRechargeOrder,
  getRechargeAvailability,
  getRechargeOrderAdmin,
  getRechargeOrderForKey,
  getRechargePaymentConfig,
  handleAlipayRechargeCallback,
  listRechargeOrdersAdmin,
  listRechargeOrdersForKey,
  RechargeError,
  updateRechargePaymentConfig,
} from "@/repository/recharge";

export async function getMyRechargeAvailability(c: Context): Promise<Response> {
  const auth = requireSession(c);
  if (auth instanceof Response) return auth;
  return jsonResponse(await getRechargeAvailability(auth.session.key.id));
}

export async function listMyRechargeOrders(c: Context): Promise<Response> {
  const auth = requireSession(c);
  if (auth instanceof Response) return auth;
  return jsonResponse({ items: await listRechargeOrdersForKey(auth.session.key.id) });
}

export async function getMyRechargeOrder(c: Context): Promise<Response> {
  const auth = requireSession(c);
  if (auth instanceof Response) return auth;
  const orderId = parseOrderId(c);
  if (orderId instanceof Response) return orderId;
  const order = await getRechargeOrderForKey(orderId, auth.session.key.id);
  if (!order) return rechargeProblem(c, new RechargeError("ORDER_NOT_FOUND"));
  return jsonResponse(order);
}

export async function createMyRechargeOrder(c: Context): Promise<Response> {
  const auth = requireSession(c);
  if (auth instanceof Response) return auth;
  const body = await parseHonoJsonBody(c, RechargeOrderCreateSchema);
  if (!body.ok) return body.response;

  try {
    const order = await createRechargeOrder({
      keyId: auth.session.key.id,
      userId: auth.session.user.id,
      creditUsd: body.data.creditUsd,
      requestOrigin: new URL(c.req.url).origin,
    });
    audit(c, auth, "recharge.order.create", order.id, {
      orderNo: order.orderNo,
      creditUsd: order.creditUsd,
      paidAmountCny: order.paidAmountCny,
    });
    return jsonResponse(order, { status: 201 });
  } catch (error) {
    audit(c, auth, "recharge.order.create", null, null, false, error);
    return rechargeProblem(c, error);
  }
}

export async function cancelMyRechargeOrder(c: Context): Promise<Response> {
  const auth = requireSession(c);
  if (auth instanceof Response) return auth;
  const orderId = parseOrderId(c);
  if (orderId instanceof Response) return orderId;
  try {
    const order = await cancelRechargeOrderForKey(orderId, auth.session.key.id);
    audit(c, auth, "recharge.order.cancel", order.id, { orderNo: order.orderNo });
    return jsonResponse(order);
  } catch (error) {
    audit(c, auth, "recharge.order.cancel", orderId, null, false, error);
    return rechargeProblem(c, error);
  }
}

export async function alipayRechargeNotify(c: Context): Promise<Response> {
  try {
    const body = await c.req.parseBody();
    const params = Object.fromEntries(
      Object.entries(body).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value]] : []
      )
    );
    const result = await handleAlipayRechargeCallback(params);
    audit(c, null, "recharge.callback.accept", result.orderId, {
      settled: result.settled,
      orderNo: params.out_trade_no,
      tradeNo: params.trade_no,
    });
    return new Response("success", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    audit(c, null, "recharge.callback.reject", null, null, false, error);
    return new Response("failure", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

export async function getRechargeConfigAdmin(_c: Context): Promise<Response> {
  return jsonResponse(await getRechargePaymentConfig());
}

export async function updateRechargeConfigAdmin(c: Context): Promise<Response> {
  const auth = requireSession(c);
  if (auth instanceof Response) return auth;
  const body = await parseHonoJsonBody(c, RechargePaymentConfigUpdateSchema);
  if (!body.ok) return body.response;
  try {
    const before = await getRechargePaymentConfig();
    const config = await updateRechargePaymentConfig(body.data, auth.session.user.id);
    audit(c, auth, "recharge.config.update", config.id, { before, after: config });
    return jsonResponse(config);
  } catch (error) {
    audit(c, auth, "recharge.config.update", null, null, false, error);
    return rechargeProblem(c, error);
  }
}

export async function listRechargeOrdersAdminHandler(c: Context): Promise<Response> {
  const query = RechargeAdminOrderQuerySchema.safeParse({
    status: c.req.query("status"),
    needsManualHandling: c.req.query("needsManualHandling"),
    search: c.req.query("search"),
    page: c.req.query("page"),
    pageSize: c.req.query("pageSize"),
  });
  if (!query.success) return fromZodError(query.error, new URL(c.req.url).pathname);
  return jsonResponse(
    await listRechargeOrdersAdmin({
      ...query.data,
      needsManualHandling: query.data.needsManualHandling === "true",
    })
  );
}

export async function getRechargeOrderAdminHandler(c: Context): Promise<Response> {
  const orderId = parseOrderId(c);
  if (orderId instanceof Response) return orderId;
  const order = await getRechargeOrderAdmin(orderId);
  if (!order) return rechargeProblem(c, new RechargeError("ORDER_NOT_FOUND"));
  return jsonResponse(order);
}

export async function confirmRechargeOrderAdminHandler(c: Context): Promise<Response> {
  return runAdminOrderAction(c, "recharge.order.confirm", adminConfirmRechargeOrder);
}

export async function retryRechargeOrderAdminHandler(c: Context): Promise<Response> {
  const auth = requireSession(c);
  if (auth instanceof Response) return auth;
  const orderId = parseOrderId(c);
  if (orderId instanceof Response) return orderId;
  try {
    const order = await adminRetryRechargeOrder(orderId);
    audit(c, auth, "recharge.order.retry", order.id, { orderNo: order.orderNo });
    return jsonResponse(order);
  } catch (error) {
    audit(c, auth, "recharge.order.retry", orderId, null, false, error);
    return rechargeProblem(c, error);
  }
}

export async function cancelRechargeOrderAdminHandler(c: Context): Promise<Response> {
  return runAdminOrderAction(c, "recharge.order.admin_cancel", adminCancelRechargeOrder);
}

export async function closeRechargeOrderAdminHandler(c: Context): Promise<Response> {
  return runAdminOrderAction(c, "recharge.order.close", adminCloseRechargeOrder);
}

async function runAdminOrderAction(
  c: Context,
  action: string,
  operation: (orderId: number, operatorUserId: number, reason: string) => Promise<unknown>
): Promise<Response> {
  const auth = requireSession(c);
  if (auth instanceof Response) return auth;
  const orderId = parseOrderId(c);
  if (orderId instanceof Response) return orderId;
  const body = await parseHonoJsonBody(c, RechargeAdminReasonSchema);
  if (!body.ok) return body.response;
  try {
    const order = await operation(orderId, auth.session.user.id, body.data.reason);
    audit(c, auth, action, orderId, { reason: body.data.reason });
    return jsonResponse(order);
  } catch (error) {
    audit(c, auth, action, orderId, { reason: body.data.reason }, false, error);
    return rechargeProblem(c, error);
  }
}

function requireSession(
  c: Context
): (ResolvedAuth & { session: NonNullable<ResolvedAuth["session"]> }) | Response {
  const auth = c.get("auth") as ResolvedAuth | undefined;
  if (!auth?.session) {
    return createProblemResponse({
      status: 401,
      instance: new URL(c.req.url).pathname,
      errorCode: "auth.invalid",
      detail: "Authentication is invalid or expired.",
    });
  }
  return auth as ResolvedAuth & { session: NonNullable<ResolvedAuth["session"]> };
}

function parseOrderId(c: Context): number | Response {
  const raw = (c.req.param("orderId") ?? "").replace(/:(cancel|confirm|retry|close)$/, "");
  const parsed = RechargeOrderIdParamSchema.safeParse({ orderId: raw });
  return parsed.success
    ? parsed.data.orderId
    : fromZodError(parsed.error, new URL(c.req.url).pathname);
}

function rechargeProblem(c: Context, error: unknown): Response {
  const code = error instanceof RechargeError ? error.code : "INTERNAL_ERROR";
  const status =
    code.includes("NOT_FOUND") || code.includes("MISSING")
      ? 404
      : code.includes("EXISTS") || code.includes("NOT_PENDING") || code.includes("CANNOT")
        ? 409
        : code.includes("DISABLED") || code.includes("ALIPAY")
          ? 503
          : 422;
  return createProblemResponse({
    status,
    instance: new URL(c.req.url).pathname,
    errorCode: `recharge.${code.toLowerCase()}`,
    detail: code,
  });
}

function audit(
  c: Context,
  auth: (ResolvedAuth & { session: NonNullable<ResolvedAuth["session"]> }) | null,
  actionType: string,
  targetId: number | null,
  afterValue?: unknown,
  success = true,
  error?: unknown
): void {
  const request = getRequestContext();
  void createAuditLogAsync({
    actionCategory: "recharge",
    actionType,
    targetType: "recharge_order",
    targetId: targetId === null ? null : String(targetId),
    afterValue: afterValue ?? null,
    operatorUserId: auth?.session.user.id ?? null,
    operatorUserName: auth?.session.user.name ?? null,
    operatorKeyId: auth?.session.key.id ?? null,
    operatorKeyName: auth?.session.key.name ?? null,
    operatorIp: request.ip,
    userAgent: request.userAgent ?? c.req.header("user-agent") ?? null,
    success,
    errorMessage: success ? null : error instanceof Error ? error.message : String(error),
  });
}
