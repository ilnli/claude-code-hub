import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types/provider";

let findSiteMock: ReturnType<typeof vi.fn>;

vi.mock("@/repository/upstream-site", () => ({
  findUpstreamSiteProbeConfigForProvider: (...args: unknown[]) => findSiteMock(...args),
}));

import { resolveNewapiProbeRequestContext } from "@/lib/upstream-billing/newapi-probe-context";

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 12,
    name: "provider",
    url: "https://example.com/prefix/v1",
    proxyUrl: "http://provider-proxy.example.com:8080",
    proxyFallbackToDirect: false,
    upstreamSiteId: 4,
    ...overrides,
  } as Provider;
}

describe("resolveNewapiProbeRequestContext", () => {
  beforeEach(() => {
    findSiteMock = vi.fn();
  });

  it("uses the site target, PAT, and proxy when a target is configured", async () => {
    findSiteMock.mockResolvedValue({
      id: 4,
      siteKey: "example.com",
      probeBaseUrl: "https://example.com/management",
      dashboardPat: "pat-secret",
      allowInsecureHttp: false,
      proxyUrl: "socks5://site-proxy.example.com:1080",
      proxyFallbackToDirect: true,
      updatedAt: new Date("2026-08-10T00:00:00.000Z"),
    });

    const context = await resolveNewapiProbeRequestContext(makeProvider());

    expect(context).toMatchObject({
      baseUrl: "https://example.com/management",
      siteId: 4,
      dashboardPat: "pat-secret",
      proxyConfig: {
        id: 4,
        proxyUrl: "socks5://site-proxy.example.com:1080",
        proxyFallbackToDirect: true,
      },
    });
    expect(context?.cacheKey).toMatch(/^site:4:/);
  });

  it("keeps the legacy Provider target and proxy until a site target is configured", async () => {
    findSiteMock.mockResolvedValue({
      id: 4,
      siteKey: "example.com",
      probeBaseUrl: null,
      dashboardPat: null,
      allowInsecureHttp: false,
      proxyUrl: "socks5://ignored.example.com:1080",
      proxyFallbackToDirect: true,
      updatedAt: new Date(),
    });
    const provider = makeProvider();

    const context = await resolveNewapiProbeRequestContext(provider);

    expect(context).toMatchObject({
      baseUrl: "https://example.com/prefix",
      siteId: 4,
      dashboardPat: null,
      proxyConfig: provider,
    });
  });

  it("returns null for an invalid legacy Provider URL", async () => {
    findSiteMock.mockResolvedValue(null);
    expect(await resolveNewapiProbeRequestContext(makeProvider({ url: "not-a-url" }))).toBeNull();
  });
});
