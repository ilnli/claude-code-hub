import { describe, expect, it } from "vitest";
import {
  resolveRechargePaymentConfig,
  validateRechargePaymentConfig,
} from "@/lib/recharge/payment-config";

const current = {
  enabled: true,
  appId: "old-app",
  privateKey: "old-private",
  alipayPublicKey: "old-alipay-public",
  productName: "SKHUB",
  notifyDomain: "https://old.example.com",
  feeRatePercent: "0.3800",
  minCreditUsd: "1.00",
  maxCreditUsd: "1000.00",
};

describe("recharge payment config", () => {
  it("keeps existing secrets only when the update deliberately omits them", () => {
    const resolved = resolveRechargePaymentConfig(
      { appId: "new-app", productName: "New product" },
      current
    );

    expect(resolved.privateKey).toBe(current.privateKey);
    expect(resolved.alipayPublicKey).toBe(current.alipayPublicKey);
    expect(resolved.appId).toBe("new-app");
  });

  it("replaces both secrets when a replacement is submitted", () => {
    const resolved = resolveRechargePaymentConfig(
      {
        privateKey: " new-private ",
        alipayPublicKey: " new-alipay-public ",
      },
      current
    );

    expect(resolved.privateKey).toBe("new-private");
    expect(resolved.alipayPublicKey).toBe("new-alipay-public");
  });

  it("does not treat a single replacement secret as a complete key pair", () => {
    const resolved = resolveRechargePaymentConfig({ privateKey: "new-private" }, current);

    expect(resolved.privateKey).toBe("new-private");
    expect(resolved.alipayPublicKey).toBe(current.alipayPublicKey);
  });

  it("rejects an incomplete first configuration before any persistence can happen", () => {
    const resolved = resolveRechargePaymentConfig(
      { appId: "app", privateKey: "private", alipayPublicKey: "public" },
      null
    );

    expect(() => validateRechargePaymentConfig(resolved)).toThrow("CONFIG_REQUIRED_FIELDS_MISSING");
  });

  it("accepts a complete configuration with the default range", () => {
    const resolved = resolveRechargePaymentConfig(
      {
        appId: "app",
        privateKey: "private",
        alipayPublicKey: "public",
        productName: "SKHUB",
        feeRatePercent: "0.3800",
        minCreditUsd: "1",
        maxCreditUsd: "1000",
      },
      null
    );

    expect(() => validateRechargePaymentConfig(resolved)).not.toThrow();
  });
});
