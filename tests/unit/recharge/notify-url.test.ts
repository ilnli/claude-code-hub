import { describe, expect, it } from "vitest";
import { buildAlipayNotifyUrl } from "@/lib/recharge/notify-url";

describe("Alipay notify URL", () => {
  it("prefers the explicit payment-domain override", () => {
    expect(
      buildAlipayNotifyUrl(
        "https://payments.example.com/path",
        "https://app.example.com",
        "https://internal.example.com"
      )
    ).toBe("https://payments.example.com/api/v1/recharge/alipay/notify");
  });

  it("uses APP_URL before the request origin", () => {
    expect(
      buildAlipayNotifyUrl(null, "https://app.example.com/base", "https://0.0.0.0:23000")
    ).toBe("https://app.example.com/api/v1/recharge/alipay/notify");
  });

  it("falls back to the request origin when APP_URL is absent", () => {
    expect(buildAlipayNotifyUrl(null, undefined, "https://public.example.com:8443/path")).toBe(
      "https://public.example.com:8443/api/v1/recharge/alipay/notify"
    );
  });
});
