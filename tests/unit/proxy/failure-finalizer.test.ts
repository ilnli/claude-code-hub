import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_ERROR_I18N_KEYS } from "@/types/public-error";

const createMessageRequest = vi.hoisted(() => vi.fn());
const updateMessageRequestPublicErrorDurably = vi.hoisted(() => vi.fn());
const ensureCorrelation = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());

vi.mock("@/repository/message", () => ({
  createMessageRequest,
  updateMessageRequestPublicErrorDurably,
}));

vi.mock("@/app/v1/_lib/proxy/session-guard", () => ({
  ProxySessionGuard: { ensureCorrelation },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: loggerError },
}));

vi.mock("next-intl/server", () => ({
  getLocale: vi.fn().mockResolvedValue("en"),
}));

vi.mock("@/lib/utils/error-messages", () => ({
  getErrorMessageServer: vi.fn(async (_locale: string, code: string) => `public:${code}`),
}));

function makeSession(overrides: Record<string, unknown> = {}) {
  const session = {
    requestUuid: "11111111-1111-4111-8111-111111111111",
    startTime: Date.now() - 25,
    authState: {
      user: { id: 7 },
      key: { id: 8 },
      apiKey: "sk-owned",
      success: true,
    },
    provider: null,
    messageContext: null,
    request: { model: "claude-test" },
    sessionId: "cch-session-id",
    userAgent: "test-client",
    clientIp: "203.0.113.9",
    getTerminalFailureMetadata: vi.fn(() => ({
      code: "service_unavailable",
      adminMessage: "No available provider",
    })),
    getSessionIdentityMetadata: vi.fn(() => ({
      identity: "sid:cch-session-id:8",
      kind: "session_id",
      scopeTag: null,
      fingerprint: null,
      fingerprints: [],
    })),
    getOriginalModel: vi.fn(() => null),
    getGroupCostMultiplier: vi.fn(() => null),
    getRequestSequence: vi.fn(() => 3),
    getProviderChain: vi.fn(() => []),
    getRoutingTrace: vi.fn(() => null),
    getManagedEndpoint: vi.fn(() => "/v1/messages"),
    getMessagesLength: vi.fn(() => 1),
    getSpecialSettings: vi.fn(() => []),
    setMessageContext: vi.fn(),
    ...overrides,
  };

  return session;
}

describe("finalizeFailedRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureCorrelation.mockResolvedValue(undefined);
    createMessageRequest.mockResolvedValue({ id: 91, createdAt: new Date("2026-08-11T00:00:00Z") });
    updateMessageRequestPublicErrorDurably.mockResolvedValue(undefined);
  });

  it("ignores successful responses", async () => {
    const { finalizeFailedRequest } = await import("@/app/v1/_lib/proxy/failure-finalizer");

    await finalizeFailedRequest(makeSession() as never, new Response(null, { status: 204 }));

    expect(ensureCorrelation).not.toHaveBeenCalled();
    expect(createMessageRequest).not.toHaveBeenCalled();
  });

  it("ignores failures that cannot be attributed to a user and key", async () => {
    const { finalizeFailedRequest } = await import("@/app/v1/_lib/proxy/failure-finalizer");
    const session = makeSession({
      authState: {
        user: null,
        key: null,
        apiKey: "sk-unknown",
        success: false,
      },
    });

    await finalizeFailedRequest(session as never, new Response(null, { status: 401 }));

    expect(ensureCorrelation).not.toHaveBeenCalled();
    expect(createMessageRequest).not.toHaveBeenCalled();
  });

  it("creates one zero-cost request record for a pre-provider failure", async () => {
    const { finalizeFailedRequest } = await import("@/app/v1/_lib/proxy/failure-finalizer");
    const session = makeSession();

    await finalizeFailedRequest(session as never, new Response(null, { status: 503 }));

    expect(ensureCorrelation).toHaveBeenCalledWith(session);
    expect(createMessageRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request_uuid: "11111111-1111-4111-8111-111111111111",
        provider_id: null,
        user_id: 7,
        key: "sk-owned",
        status_code: 503,
        cost_usd: 0,
        public_error_code: "service_unavailable",
        public_error_message: "public:PUBLIC_ERROR_SERVICE_UNAVAILABLE",
        error_message: "No available provider",
        session_id: "cch-session-id",
        request_sequence: 3,
      })
    );
    expect(session.setMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({ id: 91, user: session.authState.user, key: session.authState.key })
    );
  });

  it("updates the public error fields when the request row already exists", async () => {
    const { finalizeFailedRequest } = await import("@/app/v1/_lib/proxy/failure-finalizer");
    const session = makeSession({
      messageContext: {
        id: 42,
        createdAt: new Date("2026-08-11T00:00:00Z"),
        user: { id: 7 },
        key: { id: 8 },
        apiKey: "sk-owned",
      },
    });

    await finalizeFailedRequest(session as never, new Response(null, { status: 429 }));

    expect(updateMessageRequestPublicErrorDurably).toHaveBeenCalledWith(42, {
      publicErrorCode: "service_unavailable",
      publicErrorMessage: "public:PUBLIC_ERROR_SERVICE_UNAVAILABLE",
    });
    expect(createMessageRequest).not.toHaveBeenCalled();
  });

  it("does not replace the client response when persistence fails", async () => {
    const { finalizeFailedRequest } = await import("@/app/v1/_lib/proxy/failure-finalizer");
    createMessageRequest.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      finalizeFailedRequest(makeSession() as never, new Response(null, { status: 500 }))
    ).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      "[FailureFinalizer] Failed to persist terminal request failure",
      expect.objectContaining({ statusCode: 500, error: "database unavailable" })
    );
  });

  it("stores a thrown pre-provider error for administrator diagnostics only", async () => {
    const { finalizeFailedRequest } = await import("@/app/v1/_lib/proxy/failure-finalizer");
    const session = makeSession({ getTerminalFailureMetadata: vi.fn(() => null) });

    await finalizeFailedRequest(
      session as never,
      new Response(null, { status: 503 }),
      new Error("No available provider")
    );

    expect(createMessageRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        error_message: "No available provider",
        public_error_code: "service_unavailable",
        public_error_message: "public:PUBLIC_ERROR_SERVICE_UNAVAILABLE",
      })
    );
  });

  it.each([
    [401, "authentication_failed"],
    [403, "authentication_failed"],
    [402, "quota_exceeded"],
    [429, "rate_limited"],
    [499, "request_cancelled"],
    [500, "service_unavailable"],
    [400, "invalid_request"],
  ] as const)("classifies HTTP %i as %s without guard metadata", async (status, code) => {
    const { finalizeFailedRequest } = await import("@/app/v1/_lib/proxy/failure-finalizer");
    const session = makeSession({ getTerminalFailureMetadata: vi.fn(() => null) });

    await finalizeFailedRequest(session as never, new Response(null, { status }));

    expect(createMessageRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        status_code: status,
        public_error_code: code,
        public_error_message: `public:${PUBLIC_ERROR_I18N_KEYS[code]}`,
      })
    );
  });
});
