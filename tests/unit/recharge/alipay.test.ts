import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAlipaySignContent,
  signAlipayParameters,
  verifyAlipaySignature,
} from "@/lib/recharge/alipay";

function testKeyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

describe("Alipay RSA2 signing", () => {
  it("sorts parameters and excludes sign fields", () => {
    expect(
      buildAlipaySignContent({ b: "2", a: "1", sign: "ignored", sign_type: "RSA2", empty: "" })
    ).toBe("a=1&b=2");
  });

  it("signs and verifies callback parameters with a PEM key", () => {
    const pair = testKeyPair();
    const params = {
      app_id: "20240001",
      out_trade_no: "RC001",
      trade_no: "ALI001",
      trade_status: "TRADE_SUCCESS",
      total_amount: "100.39",
    };
    const sign = signAlipayParameters(params, pair.privateKey);
    expect(verifyAlipaySignature({ ...params, sign }, pair.publicKey)).toBe(true);
    expect(verifyAlipaySignature({ ...params, total_amount: "100.38", sign }, pair.publicKey)).toBe(
      false
    );
  });

  it("accepts raw base64 key material", () => {
    const pair = testKeyPair();
    const rawPrivate = pair.privateKey
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replaceAll(/\s/g, "");
    const rawPublic = pair.publicKey
      .replace("-----BEGIN PUBLIC KEY-----", "")
      .replace("-----END PUBLIC KEY-----", "")
      .replaceAll(/\s/g, "");
    const params = { out_trade_no: "RC002", trade_status: "TRADE_SUCCESS" };
    const sign = signAlipayParameters(params, rawPrivate);
    expect(verifyAlipaySignature({ ...params, sign }, rawPublic)).toBe(true);
  });
});
