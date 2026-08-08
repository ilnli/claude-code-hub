import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAlipaySignContent,
  createAlipayPrecreatePayment,
  isValidAlipayPublicKey,
  signAlipayParameters,
  verifyAlipaySignature,
} from "@/lib/recharge/alipay";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("validates PEM and raw Alipay public keys", () => {
    const pair = testKeyPair();
    const rawPublic = pair.publicKey
      .replace("-----BEGIN PUBLIC KEY-----", "")
      .replace("-----END PUBLIC KEY-----", "")
      .replaceAll(/\s/g, "");

    expect(isValidAlipayPublicKey(pair.publicKey)).toBe(true);
    expect(isValidAlipayPublicKey(rawPublic)).toBe(true);
    expect(isValidAlipayPublicKey("not-a-public-key")).toBe(false);
  });

  it("uses the v2board-compatible GET query for precreate", async () => {
    const pair = testKeyPair();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          alipay_trade_precreate_response: {
            code: "10000",
            msg: "Success",
            qr_code: "https://qr.example.test/RC003",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAlipayPrecreatePayment({
      appId: "20240001",
      privateKey: pair.privateKey,
      alipayPublicKey: pair.publicKey,
      notifyUrl: "https://app.example.test/api/v1/recharge/alipay/notify",
      orderNo: "RC003",
      subject: "SKHUB",
      totalAmount: "10.04",
    });

    expect(result.qrCode).toBe("https://qr.example.test/RC003");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [request, options] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(request).toBeInstanceOf(URL);
    expect(request.origin + request.pathname).toBe("https://openapi.alipay.com/gateway.do");
    expect(options.method).toBe("GET");
    expect(options.body).toBeUndefined();

    const params = Object.fromEntries(request.searchParams.entries());
    expect(params._input_charset).toBe("UTF-8");
    expect(params.biz_content).toBe(
      JSON.stringify({ subject: "SKHUB", out_trade_no: "RC003", total_amount: "10.04" })
    );
    expect(verifyAlipaySignature(params, pair.publicKey)).toBe(true);
  });
});
