export const PUBLIC_ERROR_CODES = [
  "authentication_failed",
  "account_unavailable",
  "invalid_request",
  "request_blocked",
  "rate_limited",
  "quota_exceeded",
  "service_unavailable",
  "request_cancelled",
  "internal_error",
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

export const PUBLIC_ERROR_I18N_KEYS: Record<PublicErrorCode, string> = {
  authentication_failed: "PUBLIC_ERROR_AUTHENTICATION_FAILED",
  account_unavailable: "PUBLIC_ERROR_ACCOUNT_UNAVAILABLE",
  invalid_request: "PUBLIC_ERROR_INVALID_REQUEST",
  request_blocked: "PUBLIC_ERROR_REQUEST_BLOCKED",
  rate_limited: "PUBLIC_ERROR_RATE_LIMITED",
  quota_exceeded: "PUBLIC_ERROR_QUOTA_EXCEEDED",
  service_unavailable: "PUBLIC_ERROR_SERVICE_UNAVAILABLE",
  request_cancelled: "PUBLIC_ERROR_REQUEST_CANCELLED",
  internal_error: "PUBLIC_ERROR_INTERNAL",
};
