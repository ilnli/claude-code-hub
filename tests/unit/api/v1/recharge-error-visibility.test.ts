import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RechargeError extends Error {
    constructor(
      public readonly code: string,
      message = code
    ) {
      super(message);
      this.name = "RechargeError";
    }
  }

  return {
    RechargeError,
    createAuditLogAsync: vi.fn(),
    createRechargeOrder: vi.fn(),
    testRechargePaymentConfig: vi.fn(),
  };
});

vi.mock("@/repository/recharge", () => ({
  RechargeError: mocks.RechargeError,
  adminCancelRechargeOrder: vi.fn(),
  adminCloseRechargeOrder: vi.fn(),
  adminConfirmRechargeOrder: vi.fn(),
  adminRetryRechargeOrder: vi.fn(),
  cancelRechargeOrderForKey: vi.fn(),
  createRechargeOrder: mocks.createRechargeOrder,
  getRechargeAvailability: vi.fn(),
  getRechargeOrderAdmin: vi.fn(),
  getRechargeOrderForKey: vi.fn(),
  getRechargePaymentConfig: vi.fn(),
  handleAlipayRechargeCallback: vi.fn(),
  listRechargeOrdersAdmin: vi.fn(),
  listRechargeOrdersForKey: vi.fn(),
  testRechargePaymentConfig: mocks.testRechargePaymentConfig,
  updateRechargePaymentConfig: vi.fn(),
}));

vi.mock("@/repository/audit-log", () => ({
  createAuditLogAsync: mocks.createAuditLogAsync,
}));

vi.mock("@/lib/audit/request-context", () => ({
  getRequestContext: () => ({ ip: null, userAgent: null }),
}));

function makeContext(body: unknown, url: string): Context {
  return {
    req: {
      url,
      header: (name: string) =>
        name.toLowerCase() === "content-type" ? "application/json" : undefined,
      json: async () => body,
      raw: { headers: new Headers({ "content-type": "application/json" }) },
    },
    get: (name: string) =>
      name === "auth"
        ? {
            session: {
              user: { id: 1, name: "admin" },
              key: { id: 2, name: "test-key" },
            },
          }
        : undefined,
  } as unknown as Context;
}

describe("recharge error visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides the upstream Alipay message from ordinary users", async () => {
    mocks.createRechargeOrder.mockRejectedValueOnce(
      new mocks.RechargeError("ALIPAY_PRECREATE_FAILED", "Invalid app credential: secret")
    );
    const { createMyRechargeOrder } = await import("@/app/api/v1/resources/recharge/handlers");

    const response = await createMyRechargeOrder(
      makeContext({ creditUsd: "10.00" }, "http://localhost/api/v1/recharge/orders")
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      errorCode: "recharge.alipay_precreate_failed",
      detail: "ALIPAY_PRECREATE_FAILED",
    });
    expect(JSON.stringify(body)).not.toContain("Invalid app credential");
  });

  it("keeps the upstream diagnostic for the administrator configuration test", async () => {
    mocks.testRechargePaymentConfig.mockRejectedValueOnce(
      new mocks.RechargeError("ALIPAY_PRECREATE_FAILED", "Invalid Alipay public key")
    );
    const { testRechargeConfigAdmin } = await import("@/app/api/v1/resources/recharge/handlers");

    const response = await testRechargeConfigAdmin(
      makeContext({}, "http://localhost/api/v1/recharge/config:test")
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ detail: "Invalid Alipay public key" });
  });
});
