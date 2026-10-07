import { describe, expect, test } from "vitest";
import { buildRequestDiagnosticExport } from "@/lib/usage-logs/request-diagnostic-export";

describe("single request diagnostic export", () => {
  test("preserves absent usage versus zero and keeps billing and routing evidence", () => {
    const details = {
      requestId: 901,
      createdAt: new Date("2026-10-07T10:00:00Z"),
      statusCode: 500,
      errorMessage: "Client aborted request",
      inputTokens: null,
      outputTokens: undefined,
      cacheReadInputTokens: 0,
      costUsd: "0",
      costBreakdown: null,
      providerChain: [
        {
          id: 1,
          reason: "client_abort",
          errorDetails: {
            system: { errorName: "AbortError", errorMessage: "The operation was aborted" },
          },
          modelRedirect: {
            originalModel: "A",
            redirectedModel: "C",
            steps: [{ source: "A", target: "C" }],
          },
        },
      ],
      routingTrace: {
        mode: "legacy_serial",
        events: [{ type: "request_finished", statusCode: 500 }],
      },
    };
    const exported = buildRequestDiagnosticExport(details);
    expect(exported.filename).toBe("cch-request-901.json");
    expect(JSON.parse(exported.content)).toMatchObject({
      schemaVersion: 1,
      exportedAt: expect.any(String),
      request: { ...details, createdAt: "2026-10-07T10:00:00.000Z", outputTokens: null },
    });
    expect(details.outputTokens).toBeUndefined();
  });

  test("omits raw bodies and headers and redacts structured and embedded credentials", () => {
    const details = {
      requestId: 12,
      providerChain: [
        {
          endpointUrl: "https://user:secret@upstream.test/v1?api_key=private&region=eu",
          errorMessage: "Failed with Bearer abc.def-123 and sk-abcdefghijklmnopqrstuvwx",
          errorDetails: {
            request: {
              headers: "Authorization: Bearer private",
              body: '{"messages":["private prompt"]}',
            },
            provider: {
              upstreamBody: "private response",
              upstreamParsed: { prompt: "private prompt" },
            },
          },
        },
      ],
      auth: {
        api_key: "private-key",
        cookie: "session=private",
        accessToken: "private-token",
        key: null,
      },
    };
    const result = buildRequestDiagnosticExport(details);
    expect(result.content).not.toContain("private");
    expect(result.content).not.toContain("abc.def-123");
    expect(result.content).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(result.content).not.toContain("user:secret");
    expect(JSON.parse(result.content).request.auth).toEqual({
      api_key: "[REDACTED]",
      cookie: "[REDACTED]",
      accessToken: "[REDACTED]",
      key: null,
    });
    expect(details.auth.api_key).toBe("private-key");
  });

  test("exports incomplete requests without inventing an ID or token count", () => {
    const result = buildRequestDiagnosticExport({
      requestId: null,
      statusCode: null,
      inputTokens: null,
      headers: null,
    });
    expect(result.filename).toBe("cch-request-unknown.json");
    expect(JSON.parse(result.content).request).toEqual({
      requestId: null,
      statusCode: null,
      inputTokens: null,
      headers: null,
    });
  });
});
