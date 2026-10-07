import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { getRequestModelMappingContext } from "@/app/v1/_lib/proxy/model-mapping-context";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { GlobalModelRedirectRule } from "@/types/model-mapping";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
vi.mock("@/lib/config", () => ({ getCachedSystemSettings: mocks.getSettings }));
const rules: GlobalModelRedirectRule[] = [
  { matchType: "exact", source: "A", target: "B", excludedProviderIds: [] },
];
const provider = { id: 1, modelRedirects: null };
const session = (path = "/v1/messages") =>
  ({
    getEndpointPolicy: () => resolveEndpointPolicy(path),
  }) as ProxySession;

beforeEach(() => {
  mocks.getSettings.mockResolvedValue({
    globalModelRedirects: rules,
    matchProviderModelsAfterMapping: true,
  });
});

describe("request model mapping settings snapshot", () => {
  test("coalesces concurrent reads and shares the snapshot with cloned attempts", async () => {
    const request = session();
    const [first, second] = await Promise.all([
      getRequestModelMappingContext(request),
      getRequestModelMappingContext(request),
    ]);
    expect(first).toBe(second);
    const clonedAttempt = Object.assign(Object.create(Object.getPrototypeOf(request)), request);
    mocks.getSettings.mockResolvedValue({
      globalModelRedirects: [],
      matchProviderModelsAfterMapping: false,
    });
    expect(
      (await getRequestModelMappingContext(clonedAttempt)).resolve(provider, "A").redirectedModel
    ).toBe("B");
    expect(
      (await getRequestModelMappingContext(session())).resolve(provider, "A").redirectedModel
    ).toBe("A");
    expect(mocks.getSettings).toHaveBeenCalledTimes(2);
  });

  test("raw passthrough does not match a mapping that will never be applied", async () => {
    const context = await getRequestModelMappingContext(session("/v1/responses/compact"));
    expect(context.matchProviderModelsAfterMapping).toBe(false);
    expect(context.resolve(provider, "A").redirectedModel).toBe("A");
  });

  test("can resolve settings without a session for non-request callers", async () => {
    const context = await getRequestModelMappingContext();
    expect(context.matchProviderModelsAfterMapping).toBe(true);
    expect(context.resolve(provider, "A").redirectedModel).toBe("B");
  });
});
