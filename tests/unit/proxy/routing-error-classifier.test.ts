import { describe, expect, it } from "vitest";
import { ProxyError } from "@/app/v1/_lib/proxy/errors";
import {
  classifyBuiltInRoutingError,
  classifyReviewedRuleRoutingError,
  getRoutingErrorClassification,
  rememberRoutingErrorClassification,
} from "@/app/v1/_lib/proxy/routing-error-classifier";
import { StreamPrecommitError } from "@/app/v1/_lib/proxy/stream-gate/stream-content-gate";

const CONTEXT_LENGTH_PAYLOAD = {
  type: "error",
  error: {
    type: "invalid_request_error",
    code: "context_length_exceeded",
    message: "Your input exceeds the context window of this model.",
    param: "input",
  },
  sequence_number: 2,
};

describe("routing error classifier", () => {
  it("preserves context_length_exceeded through a synthetic stream-gate 502", () => {
    const error = new StreamPrecommitError("gate_error", {
      family: "anthropic",
      providerId: 1,
      providerName: "provider-a",
      frameData: JSON.stringify(CONTEXT_LENGTH_PAYLOAD),
    });

    expect(classifyBuiltInRoutingError(error)).toEqual({
      disposition: "request_terminal",
      evidenceSource: "core_code",
      evidenceCode: "context_length_exceeded",
      clientStatusCode: 400,
      clientCode: "context_length_exceeded",
      clientMessage: "Your input exceeds the context window of this model.",
      clientParam: "input",
      originalStatusCode: 200,
      syntheticStatusCode: 502,
    });
  });

  it("lets structured request evidence override a contradictory real 5xx", () => {
    const error = new ProxyError("Provider returned 502", 502, {
      body: JSON.stringify(CONTEXT_LENGTH_PAYLOAD),
      parsed: CONTEXT_LENGTH_PAYLOAD,
      origin: "upstream_http",
      originalStatusCode: 502,
    });

    expect(getRoutingErrorClassification(error)).toMatchObject({
      disposition: "request_terminal",
      clientStatusCode: 400,
      clientCode: "context_length_exceeded",
      originalStatusCode: 502,
    });
  });

  it("does not treat generic invalid_request_error text as sufficient evidence", () => {
    const error = new ProxyError("Invalid request", 400, {
      body: JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "Invalid request",
          code: "",
        },
      }),
      origin: "upstream_http",
      originalStatusCode: 400,
    });

    expect(classifyBuiltInRoutingError(error)).toBeNull();
  });

  it("classifies a 404 Invalid URL for a public v1 path as an endpoint capability gap", () => {
    const error = new ProxyError("Invalid URL (POST /v1/alpha/search)", 404, {
      body: JSON.stringify({
        error: {
          message: "Invalid URL (POST /v1/alpha/search)",
          type: "invalid_request_error",
          param: "",
          code: "",
        },
      }),
      origin: "upstream_http",
      originalStatusCode: 404,
    });

    expect(classifyBuiltInRoutingError(error)).toMatchObject({
      disposition: "endpoint_capability_gap",
      evidenceCode: "invalid_upstream_endpoint_url",
      clientStatusCode: 503,
      clientCode: "provider_capability_unavailable",
    });
  });

  it.each([
    ["context_window_exceeded", "context_length_exceeded"],
    ["input_too_long", "context_length_exceeded"],
    ["unsupported_parameter", "unsupported_parameter"],
    ["unknown_parameter", "unsupported_parameter"],
    ["invalid_parameter", "invalid_parameter"],
    ["invalid_value", "invalid_value"],
    ["missing_required_parameter", "missing_required_parameter"],
    ["content_policy_violation", "content_policy_violation"],
    ["content_filter", "content_filter"],
    ["safety_rejection", "safety_rejection"],
  ])("classifies the core request code %s", (code, clientCode) => {
    const error = new ProxyError("structured request error", 400, {
      parsed: {
        error: {
          code,
          message: "The request must be corrected.",
          param: "input",
        },
      },
      origin: "upstream_http",
    });

    expect(classifyBuiltInRoutingError(error)).toMatchObject({
      disposition: "request_terminal",
      evidenceSource: "core_code",
      evidenceCode: code,
      clientStatusCode: 400,
      clientCode,
      clientParam: "input",
    });
  });

  it.each([
    [
      "Unsupported parameter: temperature",
      "unsupported_parameter_signature",
      "unsupported_parameter",
    ],
    [
      "Missing required parameter: messages",
      "missing_required_parameter_signature",
      "missing_required_parameter",
    ],
    ["Invalid type for max_tokens", "invalid_parameter_signature", "invalid_parameter"],
  ])("uses a structured parameter signature for %s", (message, evidenceCode, clientCode) => {
    const error = new ProxyError(message, 400, {
      body: JSON.stringify({ error: { message, param: "request.option" } }),
      origin: "upstream_http",
    });

    expect(classifyBuiltInRoutingError(error)).toMatchObject({
      disposition: "request_terminal",
      evidenceSource: "core_signature",
      evidenceCode,
      clientCode,
      clientParam: "request.option",
    });
  });

  it("supports top-level structured stream error fields", () => {
    const error = new ProxyError("synthetic", 502, {
      parsed: {
        type: "error",
        code: "unsupported_parameter",
        message: "Unsupported parameter: reasoning_effort",
        param: "reasoning_effort",
      },
      origin: "synthetic_fake_200",
      originalStatusCode: 200,
    });

    expect(classifyBuiltInRoutingError(error)).toMatchObject({
      evidenceCode: "unsupported_parameter",
      clientParam: "reasoning_effort",
      originalStatusCode: 200,
      syntheticStatusCode: 502,
    });
  });

  it("requires both message and param for a parameter signature", () => {
    const error = new ProxyError("Unsupported parameter", 400, {
      body: JSON.stringify({ error: { message: "Unsupported parameter: temperature" } }),
      origin: "upstream_http",
    });

    expect(classifyBuiltInRoutingError(error)).toBeNull();
    expect(getRoutingErrorClassification(error)).toBeNull();
  });

  it("builds reviewed rule classifications with disposition-specific status handling", () => {
    const error = new ProxyError("reviewed", 502, {
      parsed: { error: { message: "Known request error", param: "input" } },
      origin: "upstream_http",
    });

    expect(
      classifyReviewedRuleRoutingError(error, {
        ruleId: 7,
        category: "prompt_limit",
        routingDisposition: "request_terminal",
        overrideStatusCode: 422,
      })
    ).toMatchObject({
      disposition: "request_terminal",
      evidenceSource: "error_rule",
      evidenceCode: "error_rule:7",
      clientStatusCode: 422,
      clientCode: "prompt_limit",
      clientMessage: "Known request error",
      clientParam: "input",
      matchedRuleId: 7,
      originalStatusCode: 502,
    });

    expect(
      classifyReviewedRuleRoutingError(error, {
        ruleId: 8,
        routingDisposition: "provider_capability_gap",
        overrideStatusCode: 429,
      })
    ).toMatchObject({
      disposition: "provider_capability_gap",
      clientStatusCode: 503,
      clientCode: "invalid_request_error",
    });
    expect(
      classifyReviewedRuleRoutingError(error, {
        routingDisposition: "request_terminal",
      })
    ).toBeNull();
  });

  it("can remember a terminal aggregate classification", () => {
    const error = new Error("aggregate");
    const classification = {
      disposition: "provider_capability_gap" as const,
      evidenceSource: "core_signature" as const,
      evidenceCode: "capability_exhaustion",
      clientStatusCode: 503,
      clientCode: "provider_capability_unavailable",
    };

    rememberRoutingErrorClassification(error, classification);

    expect(getRoutingErrorClassification(error)).toBe(classification);
    expect(getRoutingErrorClassification("not an error")).toBeNull();
  });
});
