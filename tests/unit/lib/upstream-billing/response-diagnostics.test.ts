import { describe, expect, it } from "vitest";
import { inspectUpstreamResponse } from "@/lib/upstream-billing/response-diagnostics";

describe("inspectUpstreamResponse", () => {
  it("parses normal JSON responses without marking an edge block", async () => {
    const response = new Response(JSON.stringify({ message: "invalid token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

    const result = await inspectUpstreamResponse(response);

    expect(result).toMatchObject({
      body: { message: "invalid token" },
      jsonParsed: true,
      error: "invalid token",
      edgeBlocked: false,
    });
    expect(result).not.toHaveProperty("edgeProvider");
  });

  it("does not classify Cloudflare-like wording in JSON as an edge block", async () => {
    const response = new Response(
      JSON.stringify({ resolved_rate_multiplier: 1, message: "Just a moment" }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

    const result = await inspectUpstreamResponse(response);

    expect(result).toMatchObject({
      body: { resolved_rate_multiplier: 1, message: "Just a moment" },
      jsonParsed: true,
      edgeBlocked: false,
    });
    expect(result).not.toHaveProperty("edgeProvider");
  });

  it("detects a non-403 Cloudflare block and preserves the ray id", async () => {
    const response = new Response(
      "<!doctype html><title>Attention Required! | Cloudflare</title><p>Cloudflare Ray ID: ray-123</p>",
      {
        status: 503,
        headers: {
          server: "cloudflare",
          "content-type": "text/html",
          "cf-ray": "ray-123",
        },
      }
    );

    const result = await inspectUpstreamResponse(response);

    expect(result).toMatchObject({
      jsonParsed: false,
      edgeBlocked: true,
      edgeProvider: "cloudflare",
      requestId: "ray-123",
      error: expect.stringContaining("HTTP 503, CF-Ray ray-123"),
    });
  });

  it("detects a successful-status Cloudflare managed challenge", async () => {
    const response = new Response("<html><body>Just a moment...</body></html>", {
      status: 200,
      headers: {
        server: "cloudflare",
        "content-type": "text/html",
        "cf-mitigated": "challenge",
      },
    });

    const result = await inspectUpstreamResponse(response);

    expect(result).toMatchObject({
      edgeBlocked: true,
      edgeProvider: "cloudflare",
      error: expect.stringContaining("HTTP 200"),
    });
  });

  it("does not treat an ordinary Cloudflare-proxied HTML 404 as a WAF block", async () => {
    const response = new Response("<html><body>Not found</body></html>", {
      status: 404,
      headers: {
        server: "cloudflare",
        "content-type": "text/html",
        "cf-ray": "ray-404",
      },
    });

    const result = await inspectUpstreamResponse(response);

    expect(result).toMatchObject({
      edgeBlocked: false,
      edgeProvider: "cloudflare",
      requestId: "ray-404",
    });
  });

  it("redacts credentials and caps plain-text diagnostics", async () => {
    const secret = "sk-sensitive";
    const response = new Response(`${secret} ${"x".repeat(1_000)}`, { status: 500 });

    const result = await inspectUpstreamResponse(response, [secret]);

    expect(result.edgeBlocked).toBe(false);
    expect(result.error).not.toContain(secret);
    expect(result.error).toContain("[REDACTED]");
    expect(result.error?.length).toBeLessThanOrEqual(500);
  });
});
