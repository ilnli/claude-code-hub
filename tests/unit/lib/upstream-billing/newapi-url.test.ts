import { describe, expect, it } from "vitest";
import {
  buildNewapiBaseUrl,
  buildNewapiPricingUrl,
  buildNewapiTokenLogsUrl,
} from "@/lib/upstream-billing/newapi-url";

describe("buildNewapiBaseUrl", () => {
  it("纯 origin 保持不变", () => {
    expect(buildNewapiBaseUrl("https://api.example.com")).toBe("https://api.example.com");
  });

  it("版本根剥掉 /v1", () => {
    expect(buildNewapiBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com");
  });

  it("完整端点剥掉版本段及之后的路径", () => {
    expect(buildNewapiBaseUrl("https://api.example.com/v1/messages")).toBe(
      "https://api.example.com"
    );
    expect(buildNewapiBaseUrl("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com"
    );
  });

  it("带前缀部署保留前缀", () => {
    expect(buildNewapiBaseUrl("https://api.example.com/newapi/v1")).toBe(
      "https://api.example.com/newapi"
    );
    expect(buildNewapiBaseUrl("https://api.example.com/newapi/v1/chat/completions")).toBe(
      "https://api.example.com/newapi"
    );
    expect(buildNewapiBaseUrl("https://api.example.com/newapi")).toBe(
      "https://api.example.com/newapi"
    );
  });

  it("保留端口与非 http 默认端口", () => {
    expect(buildNewapiBaseUrl("http://localhost:3000/v1")).toBe("http://localhost:3000");
  });

  it("非法 URL 抛异常（由调用方捕获）", () => {
    expect(() => buildNewapiBaseUrl("not-a-url")).toThrow();
  });
});

describe("探测端点 URL", () => {
  it("pricing 端点", () => {
    expect(buildNewapiPricingUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/api/pricing"
    );
  });

  it("token 日志端点", () => {
    expect(buildNewapiTokenLogsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/api/log/token"
    );
  });
});
