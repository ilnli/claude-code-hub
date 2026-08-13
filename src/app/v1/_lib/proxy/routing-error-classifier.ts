import type { RoutingDisposition } from "@/types/routing-error";

export type { RoutingDisposition } from "@/types/routing-error";

export type RoutingEvidenceSource = "core_code" | "core_signature" | "error_rule";

export interface RoutingErrorClassification {
  disposition: RoutingDisposition;
  evidenceSource: RoutingEvidenceSource;
  evidenceCode: string;
  clientStatusCode: number;
  clientCode: string;
  clientMessage?: string;
  clientParam?: string | null;
  originalStatusCode?: number;
  syntheticStatusCode?: number;
  matchedRuleId?: number;
}

type ProxyErrorLike = Error & {
  statusCode?: number;
  upstreamError?: {
    body?: string;
    parsed?: unknown;
    isSyntheticFake200?: boolean;
    origin?: "upstream_http" | "synthetic_fake_200" | "stream_gate_precommit";
    originalStatusCode?: number;
  };
};

type CoreRequestErrorDefinition = {
  clientStatusCode: number;
  clientCode: string;
};

const CORE_REQUEST_ERROR_CODES = new Map<string, CoreRequestErrorDefinition>([
  ["context_length_exceeded", { clientStatusCode: 400, clientCode: "context_length_exceeded" }],
  ["context_window_exceeded", { clientStatusCode: 400, clientCode: "context_length_exceeded" }],
  ["input_too_long", { clientStatusCode: 400, clientCode: "context_length_exceeded" }],
  ["unsupported_parameter", { clientStatusCode: 400, clientCode: "unsupported_parameter" }],
  ["unknown_parameter", { clientStatusCode: 400, clientCode: "unsupported_parameter" }],
  ["invalid_parameter", { clientStatusCode: 400, clientCode: "invalid_parameter" }],
  ["invalid_value", { clientStatusCode: 400, clientCode: "invalid_value" }],
  [
    "missing_required_parameter",
    { clientStatusCode: 400, clientCode: "missing_required_parameter" },
  ],
  ["content_policy_violation", { clientStatusCode: 400, clientCode: "content_policy_violation" }],
  ["content_filter", { clientStatusCode: 400, clientCode: "content_filter" }],
  ["safety_rejection", { clientStatusCode: 400, clientCode: "safety_rejection" }],
]);

const cachedClassifications = new WeakMap<Error, RoutingErrorClassification | null>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function getStringAtPaths(value: unknown, paths: ReadonlyArray<readonly string[]>): string | null {
  for (const path of paths) {
    const candidate = getPath(value, path);
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getStructuredPayload(error: ProxyErrorLike): Record<string, unknown> | null {
  if (isRecord(error.upstreamError?.parsed)) {
    return error.upstreamError.parsed;
  }
  return parseJsonObject(error.upstreamError?.body);
}

const ERROR_CODE_PATHS = [
  ["error", "code"],
  ["error", "error", "code"],
  ["error", "upstream_error", "code"],
  ["error", "upstream_error", "error", "code"],
] as const;

const ERROR_MESSAGE_PATHS = [
  ["error", "message"],
  ["error", "error", "message"],
  ["error", "upstream_error", "message"],
  ["error", "upstream_error", "error", "message"],
] as const;

const ERROR_PARAM_PATHS = [
  ["error", "param"],
  ["error", "error", "param"],
  ["error", "upstream_error", "param"],
  ["error", "upstream_error", "error", "param"],
] as const;

function getTopLevelErrorString(payload: Record<string, unknown>, field: string): string | null {
  if (payload.type !== "error") return null;
  const value = payload[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const CLIENT_PARAM_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\[[0-9]+\]|\.[A-Za-z_][A-Za-z0-9_-]*)*$/u;

function sanitizeClientParam(param: string | null): string | null {
  if (!param || param.length > 128 || !CLIENT_PARAM_RE.test(param)) return null;
  return param;
}

function getErrorFields(payload: Record<string, unknown>): {
  code: string | null;
  message: string | null;
  param: string | null;
} {
  return {
    code: getStringAtPaths(payload, ERROR_CODE_PATHS) ?? getTopLevelErrorString(payload, "code"),
    message:
      getStringAtPaths(payload, ERROR_MESSAGE_PATHS) ?? getTopLevelErrorString(payload, "message"),
    param: getStringAtPaths(payload, ERROR_PARAM_PATHS) ?? getTopLevelErrorString(payload, "param"),
  };
}

function getStatusMetadata(error: ProxyErrorLike): {
  originalStatusCode?: number;
  syntheticStatusCode?: number;
} {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : undefined;
  const originalStatusCode = error.upstreamError?.originalStatusCode;
  const isSynthetic =
    error.upstreamError?.origin === "stream_gate_precommit" ||
    error.upstreamError?.origin === "synthetic_fake_200" ||
    error.upstreamError?.isSyntheticFake200 === true;

  return {
    originalStatusCode: originalStatusCode ?? (isSynthetic ? undefined : statusCode),
    syntheticStatusCode: isSynthetic ? statusCode : undefined,
  };
}

function classifyParameterSignature(
  message: string | null,
  param: string | null
): Pick<RoutingErrorClassification, "evidenceCode" | "clientCode"> | null {
  if (!message || !param) return null;

  if (/^unsupported parameter\b/i.test(message) || /^unknown parameter\b/i.test(message)) {
    return { evidenceCode: "unsupported_parameter_signature", clientCode: "unsupported_parameter" };
  }
  if (/^missing required parameter\b/i.test(message)) {
    return {
      evidenceCode: "missing_required_parameter_signature",
      clientCode: "missing_required_parameter",
    };
  }
  if (/^invalid (?:value|type) for\b/i.test(message)) {
    return { evidenceCode: "invalid_parameter_signature", clientCode: "invalid_parameter" };
  }
  return null;
}

function classifyUncached(error: Error): RoutingErrorClassification | null {
  const proxyError = error as ProxyErrorLike;
  const payload = getStructuredPayload(proxyError);
  const statusMetadata = getStatusMetadata(proxyError);

  if (payload) {
    const { code, message, param } = getErrorFields(payload);
    const normalizedCode = code?.toLowerCase() ?? null;
    const definition = normalizedCode ? CORE_REQUEST_ERROR_CODES.get(normalizedCode) : undefined;

    if (definition) {
      return {
        disposition: "request_terminal",
        evidenceSource: "core_code",
        evidenceCode: normalizedCode as string,
        clientStatusCode: definition.clientStatusCode,
        clientCode: definition.clientCode,
        clientMessage: message ?? undefined,
        clientParam: sanitizeClientParam(param),
        ...statusMetadata,
      };
    }

    const parameterSignature = classifyParameterSignature(message, param);
    if (parameterSignature) {
      return {
        disposition: "request_terminal",
        evidenceSource: "core_signature",
        evidenceCode: parameterSignature.evidenceCode,
        clientStatusCode: 400,
        clientCode: parameterSignature.clientCode,
        clientMessage: message ?? undefined,
        clientParam: sanitizeClientParam(param),
        ...statusMetadata,
      };
    }

    const invalidUrlMatch = message?.match(/^Invalid URL \(([A-Z]+) (\/v1\/[^)\s]*)\)$/i);
    if (proxyError.statusCode === 404 && invalidUrlMatch) {
      return {
        disposition: "endpoint_capability_gap",
        evidenceSource: "core_signature",
        evidenceCode: "invalid_upstream_endpoint_url",
        clientStatusCode: 503,
        clientCode: "provider_capability_unavailable",
        clientMessage: message ?? undefined,
        ...statusMetadata,
      };
    }
  }

  return null;
}

export function classifyBuiltInRoutingError(error: Error): RoutingErrorClassification | null {
  if (cachedClassifications.has(error)) {
    return cachedClassifications.get(error) ?? null;
  }
  const classification = classifyUncached(error);
  cachedClassifications.set(error, classification);
  return classification;
}

export function classifyReviewedRuleRoutingError(
  error: Error,
  rule: {
    ruleId?: number;
    category?: string;
    routingDisposition?: RoutingDisposition;
    overrideStatusCode?: number;
  }
): RoutingErrorClassification | null {
  if (!rule.routingDisposition || rule.ruleId === undefined) return null;

  const proxyError = error as ProxyErrorLike;
  const payload = getStructuredPayload(proxyError);
  const fields = payload ? getErrorFields(payload) : { message: null, param: null };
  const terminalOverrideStatus =
    rule.routingDisposition === "request_terminal" &&
    rule.overrideStatusCode !== undefined &&
    rule.overrideStatusCode >= 400 &&
    rule.overrideStatusCode <= 499
      ? rule.overrideStatusCode
      : undefined;

  return {
    disposition: rule.routingDisposition,
    evidenceSource: "error_rule",
    evidenceCode: `error_rule:${rule.ruleId}`,
    clientStatusCode:
      terminalOverrideStatus ?? (rule.routingDisposition === "request_terminal" ? 400 : 503),
    clientCode: rule.category || "invalid_request_error",
    clientMessage: fields.message ?? undefined,
    clientParam: sanitizeClientParam(fields.param),
    matchedRuleId: rule.ruleId,
    ...getStatusMetadata(proxyError),
  };
}

export function rememberRoutingErrorClassification(
  error: Error,
  classification: RoutingErrorClassification | null
): void {
  cachedClassifications.set(error, classification);
}

export function getRoutingErrorClassification(error: unknown): RoutingErrorClassification | null {
  if (!(error instanceof Error)) return null;
  return cachedClassifications.get(error) ?? classifyBuiltInRoutingError(error);
}
