import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProxyAgentForProvider } from "@/lib/proxy-agent";
import type { Provider } from "@/types/provider";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/proxy-agent", () => ({
  createProxyAgentForProvider: vi.fn(() => null),
}));

import {
  fetchNewapiRatioTable,
  fetchNewapiTokenGroup,
  resolveModeGroupFromLogs,
  testNewapiDashboardPat,
} from "@/lib/upstream-billing/newapi-client";

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "newapi-upstream",
    url: "https://newapi.example.com/v1",
    key: "sk-test-key",
    providerType: "openai-compatible",
    proxyUrl: null,
    proxyFallbackToDirect: false,
    ...overrides,
  } as Provider;
}

function makeResponse(init: {
  ok: boolean;
  status: number;
  body?: unknown;
  stream?: Pick<ReadableStream, "cancel">;
}): Response {
  const bodyText =
    init.body === undefined
      ? ""
      : typeof init.body === "string"
        ? init.body
        : JSON.stringify(init.body);
  return {
    ok: init.ok,
    status: init.status,
    json: async () => init.body,
    text: async () => bodyText,
    body: init.stream ?? null,
  } as Response;
}

function makeSiteContext() {
  return {
    baseUrl: "https://newapi.example.com/management",
    cacheKey: "site:99:1",
    siteId: 99,
    proxyConfig: {
      id: 99,
      name: "newapi.example.com",
      proxyUrl: "http://proxy.example.com:8080",
      proxyFallbackToDirect: true,
    },
    dashboardPat: "dashboard-pat",
    dashboardUserId: 8,
  };
}

describe("fetchNewapiRatioTable", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(createProxyAgentForProvider).mockReturnValue(null);
  });

  it("200：返回 group_ratio 表", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: true,
        status: 200,
        body: { success: true, data: [], group_ratio: { default: 1, vip: 0.8 } },
      })
    );

    const result = await fetchNewapiRatioTable(makeProvider());
    expect(result).toEqual({ ok: true, table: { default: 1, vip: 0.8 } });

    // 匿名端点：不得携带凭证
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({});
    // URL 剥掉 /v1
    expect(fetchMock.mock.calls[0][0]).toBe("https://newapi.example.com/api/pricing");
  });

  it("403：pricing 模块关闭/需登录 -> unsupported", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 403 }));
    const result = await fetchNewapiRatioTable(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "unsupported", status: 403 });
  });

  it("PAT 模式使用站点目标、站点代理、Bearer PAT 和用户 UID", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ ok: true, status: 200, body: { group_ratio: { vip: 0.7 } } })
    );
    const context = makeSiteContext();

    const result = await fetchNewapiRatioTable(makeProvider(), {
      context,
      authenticated: true,
    });

    expect(result).toEqual({ ok: true, table: { vip: 0.7 } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://newapi.example.com/management/api/pricing",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer dashboard-pat",
          "New-Api-User": "8",
        },
      })
    );
    expect(createProxyAgentForProvider).toHaveBeenCalledWith(
      context.proxyConfig,
      expect.any(String)
    );
  });

  it("PAT 模式的 403 归类为鉴权失败", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: false,
        status: 403,
        body: {
          success: false,
          code: "PRICING_DISABLED",
          message: "pricing is disabled\nby administrator for dashboard-pat",
        },
      })
    );
    const result = await fetchNewapiRatioTable(makeProvider(), {
      context: makeSiteContext(),
      authenticated: true,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "auth",
      status: 403,
      error: "PRICING_DISABLED: pricing is disabled by administrator for [REDACTED]",
    });
  });

  it("PAT 模式缺少用户 UID 时不发送请求", async () => {
    const result = await fetchNewapiRatioTable(makeProvider(), {
      context: { ...makeSiteContext(), dashboardUserId: null },
      authenticated: true,
    });

    expect(result).toMatchObject({ ok: false, reason: "auth" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404：非 new-api 站点 -> unsupported", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 404 }));
    const result = await fetchNewapiRatioTable(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "unsupported", status: 404 });
  });

  it("429 -> rate_limited", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 429 }));
    const result = await fetchNewapiRatioTable(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "rate_limited", status: 429 });
  });

  it("500 -> http", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 500 }));
    const result = await fetchNewapiRatioTable(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "http", status: 500 });
  });

  it("非法 JSON -> invalid", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
      body: null,
    } as unknown as Response);
    const result = await fetchNewapiRatioTable(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("缺少 group_ratio -> invalid", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ ok: true, status: 200, body: { success: true, data: [] } })
    );
    const result = await fetchNewapiRatioTable(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("网络错误 -> network", async () => {
    fetchMock.mockRejectedValue(new Error("connect refused"));
    const result = await fetchNewapiRatioTable(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "network" });
  });

  it("provider URL 非法 -> invalid 且不发请求", async () => {
    const result = await fetchNewapiRatioTable(makeProvider({ url: "not-a-url" }));
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchNewapiTokenGroup", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(createProxyAgentForProvider).mockReturnValue(null);
  });

  it("200：返回众数分组，恒用 Bearer 头", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          success: true,
          message: "",
          data: [
            { type: 2, group: "vip" },
            { type: 2, group: "default" },
            { type: 2, group: "vip" },
          ],
        },
      })
    );

    const result = await fetchNewapiTokenGroup(makeProvider({ key: "sk-abc" }));
    expect(result).toEqual({ ok: true, group: "vip" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://newapi.example.com/api/log/token");
    expect(init.headers).toEqual({ Authorization: "Bearer sk-abc" });
  });

  it("Provider token 日志请求不携带站点 Dashboard UID", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ ok: true, status: 200, body: { success: true, data: [] } })
    );

    await fetchNewapiTokenGroup(makeProvider({ key: "sk-provider" }), makeSiteContext());

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: "Bearer sk-provider",
    });
  });

  it("空日志（冷启动/站点关日志）-> ok 且 group 为 null", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ ok: true, status: 200, body: { success: true, data: [] } })
    );
    const result = await fetchNewapiTokenGroup(makeProvider());
    expect(result).toEqual({ ok: true, group: null });
  });

  it("200 + success:false -> auth", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: true,
        status: 200,
        body: { success: false, message: "无效的令牌" },
      })
    );
    const result = await fetchNewapiTokenGroup(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "auth" });
  });

  it("401 -> auth", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 401 }));
    const result = await fetchNewapiTokenGroup(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "auth", status: 401 });
  });

  it("429 -> rate_limited", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 429 }));
    const result = await fetchNewapiTokenGroup(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "rate_limited", status: 429 });
  });

  it("404 -> unsupported", async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 404 }));
    const result = await fetchNewapiTokenGroup(makeProvider());
    expect(result).toMatchObject({ ok: false, reason: "unsupported", status: 404 });
  });
});

describe("testNewapiDashboardPat", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(createProxyAgentForProvider).mockReturnValue(null);
  });

  it("先验证身份，再验证认证价格表", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ ok: true, status: 200, body: { success: true, data: { id: 8 } } })
      )
      .mockResolvedValueOnce(
        makeResponse({ ok: true, status: 200, body: { group_ratio: { default: 1, vip: 0.8 } } })
      );

    const result = await testNewapiDashboardPat(makeProvider(), makeSiteContext());

    expect(result).toEqual({ ok: true, groupCount: 2 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://newapi.example.com/management/api/user/self",
      "https://newapi.example.com/management/api/pricing",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: "Bearer dashboard-pat",
      "New-Api-User": "8",
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      Authorization: "Bearer dashboard-pat",
      "New-Api-User": "8",
    });
  });

  it("无 PAT 时不发送请求", async () => {
    const result = await testNewapiDashboardPat(makeProvider(), {
      ...makeSiteContext(),
      dashboardPat: null,
    });
    expect(result).toMatchObject({ ok: false, reason: "auth" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("无用户 UID 时不发送请求", async () => {
    const result = await testNewapiDashboardPat(makeProvider(), {
      ...makeSiteContext(),
      dashboardUserId: null,
    });
    expect(result).toMatchObject({ ok: false, reason: "auth" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("身份响应与配置 UID 不一致时拒绝继续读取价格表", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: true, status: 200, body: { success: true, data: { id: 9 } } })
    );

    const result = await testNewapiDashboardPat(makeProvider(), makeSiteContext());

    expect(result).toMatchObject({ ok: false, stage: "identity", reason: "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("保留 HTTP 200 身份失败消息并标记 identity 阶段", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: { success: false, code: "AUTH_UNAUTHORIZED", message: "access token is invalid" },
      })
    );

    const result = await testNewapiDashboardPat(makeProvider(), makeSiteContext());

    expect(result).toEqual({
      ok: false,
      stage: "identity",
      reason: "auth",
      error: "AUTH_UNAUTHORIZED: access token is invalid",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("价格表失败时保留状态、消息并标记 pricing 阶段", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ ok: true, status: 200, body: { success: true, data: { id: 8 } } })
      )
      .mockResolvedValueOnce(
        makeResponse({
          ok: false,
          status: 403,
          body: { success: false, message: "pricing is disabled" },
        })
      );

    const result = await testNewapiDashboardPat(makeProvider(), makeSiteContext());

    expect(result).toEqual({
      ok: false,
      stage: "pricing",
      reason: "auth",
      status: 403,
      error: "pricing is disabled",
    });
  });
});

describe("resolveModeGroupFromLogs", () => {
  it("返回出现次数最多的分组", () => {
    const logs = [
      { type: 2, group: "a" },
      { type: 2, group: "b" },
      { type: 2, group: "b" },
      { type: 2, group: "a" },
      { type: 2, group: "b" },
    ];
    expect(resolveModeGroupFromLogs(logs)).toBe("b");
  });

  it("并列时取更靠前者（日志按 id 倒序，先出现即更新）", () => {
    const logs = [
      { type: 2, group: "new" },
      { type: 2, group: "old" },
      { type: 2, group: "old" },
      { type: 2, group: "new" },
    ];
    expect(resolveModeGroupFromLogs(logs)).toBe("new");
  });

  it("过滤非消费日志与空分组", () => {
    const logs = [
      { type: 5, group: "err-group" }, // 错误日志
      { type: 1, group: "topup" }, // 充值日志
      { type: 2, group: "  " }, // 空白分组
      { type: 2, group: "vip" },
    ];
    expect(resolveModeGroupFromLogs(logs)).toBe("vip");
  });

  it("全无可消费日志 -> null", () => {
    expect(resolveModeGroupFromLogs([{ type: 5, group: "x" }])).toBeNull();
    expect(resolveModeGroupFromLogs([])).toBeNull();
  });

  it("众数窗口限制为前 20 条消费日志", () => {
    // 前 20 条全是 a，之后全是 b —— b 再多也不影响结果
    const logs = [
      ...Array.from({ length: 20 }, () => ({ type: 2, group: "a" })),
      ...Array.from({ length: 80 }, () => ({ type: 2, group: "b" })),
    ];
    expect(resolveModeGroupFromLogs(logs)).toBe("a");
  });
});
