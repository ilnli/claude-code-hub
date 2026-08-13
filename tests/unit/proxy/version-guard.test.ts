import { beforeEach, describe, expect, test, vi } from "vitest";
import { ProxyVersionGuard } from "@/app/v1/_lib/proxy/version-guard";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";

const getCachedSystemSettingsMock = vi.fn();
const checkVersionMock = vi.fn();
const getErrorMessageServerMock = vi.fn();

vi.mock("@/lib/config", () => ({
  getCachedSystemSettings: () => getCachedSystemSettingsMock(),
}));

vi.mock("@/lib/client-version-checker", () => ({
  ClientVersionChecker: {
    checkVersion: (...args: unknown[]) => checkVersionMock(...args),
  },
}));

vi.mock("next-intl/server", () => ({
  getLocale: vi.fn(async () => "en"),
}));

vi.mock("@/lib/utils/error-messages", () => ({
  getErrorMessageServer: (...args: unknown[]) => getErrorMessageServerMock(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createSession(userAgent = "claude-cli/2.0.1 (external, cli)"): ProxySession {
  return {
    userAgent,
    authState: {
      user: { id: 1 },
      key: { id: 2 },
      apiKey: "sk-test",
    },
    request: { model: "test-model" },
    sessionId: "session-1",
    getOriginalModel: () => "original-model",
    getRequestSequence: () => 4,
    getMessagesLength: () => 2,
    getEndpoint: () => "/v1/messages",
    setTerminalFailureMetadata: vi.fn(),
  } as unknown as ProxySession;
}

function evaluation(
  status: "below_minimum" | "above_maximum" | "within_range" | "unparseable" | "unchecked"
) {
  return {
    status,
    minimumVersion: "2.0.0",
    maximumVersion: "2.0.2",
    waitingForBaseline: false,
    comparableVersion: status === "unparseable" ? null : "2.0.1",
  };
}

beforeEach(() => {
  getCachedSystemSettingsMock.mockResolvedValue({ enableClientVersionCheck: true });
  checkVersionMock.mockResolvedValue({
    policy: { clientType: "claude-cli" },
    evaluation: evaluation("within_range"),
  });
  getErrorMessageServerMock.mockImplementation(async (_locale, code) => `public:${code}`);
});

describe("ProxyVersionGuard", () => {
  test("blocks clients below the minimum with the legacy upgrade error contract", async () => {
    checkVersionMock.mockResolvedValue({
      policy: { clientType: "claude-cli" },
      evaluation: evaluation("below_minimum"),
    });

    const session = createSession("claude-cli/1.9.9 (external, cli)");
    const response = await ProxyVersionGuard.ensure(session);

    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body).toMatchObject({
      error: {
        type: "client_upgrade_required",
        required_version: "2.0.0",
        minimum_supported_version: "2.0.0",
        maximum_supported_version: "2.0.2",
      },
    });
    expect(session.setTerminalFailureMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "invalid_request",
        blockedBy: "client_version",
        blockedReason: expect.stringContaining('"version":"1.9.9"'),
      })
    );
  });

  test("blocks clients above the maximum without a required version", async () => {
    checkVersionMock.mockResolvedValue({
      policy: { clientType: "claude-cli" },
      evaluation: evaluation("above_maximum"),
    });

    const session = createSession("claude-cli/2.0.3 (external, cli)");
    const response = await ProxyVersionGuard.ensure(session);

    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body).toMatchObject({
      error: {
        type: "client_version_too_new",
        minimum_supported_version: "2.0.0",
        maximum_supported_version: "2.0.2",
      },
    });
    expect(body.error.required_version).toBeUndefined();
    expect(session.setTerminalFailureMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ code: "invalid_request", blockedBy: "client_version" })
    );
  });

  test("allows malformed versions and client types without a policy", async () => {
    checkVersionMock.mockResolvedValueOnce({
      policy: { clientType: "claude-cli" },
      evaluation: evaluation("unparseable"),
    });
    expect(
      await ProxyVersionGuard.ensure(createSession("claude-cli/dev (external, cli)"))
    ).toBeNull();

    checkVersionMock.mockResolvedValueOnce({ policy: null, evaluation: evaluation("unchecked") });
    expect(await ProxyVersionGuard.ensure(createSession())).toBeNull();
  });

  test("fails open when policy evaluation cannot be loaded", async () => {
    checkVersionMock.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(ProxyVersionGuard.ensure(createSession())).resolves.toBeNull();
  });
});
