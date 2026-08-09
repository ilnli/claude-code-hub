import { beforeEach, describe, expect, test, vi } from "vitest";
import { ProxyVersionGuard } from "@/app/v1/_lib/proxy/version-guard";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";

const getCachedSystemSettingsMock = vi.fn();
const checkVersionMock = vi.fn();
const insertMock = vi.fn();
const valuesMock = vi.fn();

vi.mock("@/drizzle/db", () => ({
  db: {
    insert: (...args: unknown[]) => {
      insertMock(...args);
      return { values: valuesMock };
    },
  },
}));

vi.mock("@/lib/config", () => ({
  getCachedSystemSettings: () => getCachedSystemSettingsMock(),
}));

vi.mock("@/lib/client-version-checker", () => ({
  ClientVersionChecker: {
    checkVersion: (...args: unknown[]) => checkVersionMock(...args),
  },
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
  insertMock.mockClear();
  valuesMock.mockClear();
  valuesMock.mockResolvedValue(undefined);
});

describe("ProxyVersionGuard", () => {
  test("blocks clients below the minimum with the legacy upgrade error contract", async () => {
    checkVersionMock.mockResolvedValue({
      policy: { clientType: "claude-cli" },
      evaluation: evaluation("below_minimum"),
    });

    const response = await ProxyVersionGuard.ensure(
      createSession("claude-cli/1.9.9 (external, cli)")
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({
      error: {
        type: "client_upgrade_required",
        current_version: "1.9.9",
        required_version: "2.0.0",
        minimum_supported_version: "2.0.0",
        maximum_supported_version: "2.0.2",
      },
    });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ blockedBy: "client_version", statusCode: 400 })
    );
  });

  test("blocks clients above the maximum without a required version", async () => {
    checkVersionMock.mockResolvedValue({
      policy: { clientType: "claude-cli" },
      evaluation: evaluation("above_maximum"),
    });

    const response = await ProxyVersionGuard.ensure(
      createSession("claude-cli/2.0.3 (external, cli)")
    );

    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body).toMatchObject({
      error: {
        type: "client_version_too_new",
        current_version: "2.0.3",
        minimum_supported_version: "2.0.0",
        maximum_supported_version: "2.0.2",
      },
    });
    expect(body.error.required_version).toBeUndefined();
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
    expect(valuesMock).not.toHaveBeenCalled();
  });

  test("fails open when policy evaluation cannot be loaded", async () => {
    checkVersionMock.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(ProxyVersionGuard.ensure(createSession())).resolves.toBeNull();
    expect(valuesMock).not.toHaveBeenCalled();
  });
});
