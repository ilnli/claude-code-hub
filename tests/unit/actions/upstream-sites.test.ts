import { beforeEach, describe, expect, it, vi } from "vitest";

let findUpstreamSitesMock: ReturnType<typeof vi.fn>;
let findProbeConfigMock: ReturnType<typeof vi.fn>;
let updateConfigMock: ReturnType<typeof vi.fn>;
let deleteSiteMock: ReturnType<typeof vi.fn>;
let testPatMock: ReturnType<typeof vi.fn>;
let invalidateCacheMock: ReturnType<typeof vi.fn>;
let emitAuditMock: ReturnType<typeof vi.fn>;
let loggerWarnMock: ReturnType<typeof vi.fn>;

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ user: { role: "admin" } })),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/audit/emit", () => ({
  emitActionAudit: (...args: unknown[]) => emitAuditMock(...args),
}));

vi.mock("@/lib/proxy-agent", () => ({
  isValidProxyUrl: vi.fn(() => true),
}));

vi.mock("@/lib/upstream-billing/newapi-client", () => ({
  testNewapiDashboardPat: (...args: unknown[]) => testPatMock(...args),
}));

vi.mock("@/lib/upstream-billing/newapi-table-cache", () => ({
  invalidateNewapiRatioTableCacheForSite: (...args: unknown[]) => invalidateCacheMock(...args),
}));

vi.mock("@/repository/upstream-site", () => ({
  findUpstreamSites: (...args: unknown[]) => findUpstreamSitesMock(...args),
  findUpstreamSiteProbeConfigById: (...args: unknown[]) => findProbeConfigMock(...args),
  updateUpstreamSiteConfig: (...args: unknown[]) => updateConfigMock(...args),
  deleteEmptyUpstreamSite: (...args: unknown[]) => deleteSiteMock(...args),
}));

import {
  getUpstreamSites,
  removeUpstreamSite,
  saveUpstreamSiteConfig,
  testUpstreamSitePat,
} from "@/actions/upstream-sites";

const now = new Date("2026-08-10T00:00:00.000Z");

function makeProbeConfig() {
  return {
    id: 4,
    siteKey: "example.com",
    probeBaseUrl: "https://example.com/new-api",
    dashboardPat: "stored-pat",
    dashboardUserId: 42,
    allowInsecureHttp: false,
    proxyUrl: "http://user:pass@proxy.example.com:8080",
    proxyFallbackToDirect: true,
    updatedAt: now,
  };
}

function makePublicSite() {
  return {
    id: 4,
    siteKey: "example.com",
    probeBaseUrl: "https://example.com/new-api",
    patConfigured: true,
    dashboardUserId: 42,
    allowInsecureHttp: false,
    proxyUrl: "http://user:pass@proxy.example.com:8080",
    proxyFallbackToDirect: true,
    providerCount: 2,
    newapiProviderCount: 1,
    probeTargetCandidates: ["https://example.com"],
    createdAt: now,
    updatedAt: now,
  };
}

describe("upstream site actions", () => {
  beforeEach(() => {
    findUpstreamSitesMock = vi.fn().mockResolvedValue([makePublicSite()]);
    findProbeConfigMock = vi.fn().mockResolvedValue(makeProbeConfig());
    updateConfigMock = vi.fn().mockResolvedValue(makePublicSite());
    deleteSiteMock = vi.fn().mockResolvedValue("deleted");
    testPatMock = vi.fn().mockResolvedValue({ ok: true, groupCount: 3 });
    invalidateCacheMock = vi.fn();
    emitAuditMock = vi.fn();
    loggerWarnMock = vi.fn();
  });

  it("never returns PAT and redacts proxy credentials", async () => {
    const result = await getUpstreamSites();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sites[0]).not.toHaveProperty("dashboardPat");
    expect(result.data.sites[0]?.dashboardUserId).toBe(42);
    expect(result.data.sites[0]?.proxyUrl).toContain("REDACTED");
    expect(JSON.stringify(result)).not.toContain("stored-pat");
  });

  it("omitted PAT preserves the stored value and a redacted proxy echo preserves credentials", async () => {
    const result = await saveUpstreamSiteConfig({
      siteId: 4,
      probeBaseUrl: "https://example.com/new-api",
      proxyUrl: "http://REDACTED:REDACTED@proxy.example.com:8080/",
    });

    expect(result.ok).toBe(true);
    expect(updateConfigMock).toHaveBeenCalledWith(
      4,
      expect.objectContaining({
        dashboardPat: "stored-pat",
        dashboardUserId: 42,
        proxyUrl: "http://user:pass@proxy.example.com:8080",
      })
    );
    expect(invalidateCacheMock).toHaveBeenCalledWith(4);
  });

  it("null explicitly clears the PAT", async () => {
    const result = await saveUpstreamSiteConfig({ siteId: 4, dashboardPat: null });

    expect(result.ok).toBe(true);
    expect(updateConfigMock).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ dashboardPat: null, dashboardUserId: null })
    );
    expect(emitAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "upstream_site.pat.clear", success: true })
    );
  });

  it("rejects a target on another host", async () => {
    const result = await saveUpstreamSiteConfig({
      siteId: 4,
      probeBaseUrl: "https://other.example.com/new-api",
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "upstream_site.target_host_mismatch",
    });
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it("tests an unsaved draft without writing site configuration", async () => {
    const result = await testUpstreamSitePat({
      siteId: 4,
      dashboardPat: "draft-pat",
      dashboardUserId: 84,
      probeBaseUrl: "https://example.com/draft/v1",
    });

    expect(result).toEqual({ ok: true, data: { groupCount: 3 } });
    expect(testPatMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        baseUrl: "https://example.com/draft",
        dashboardPat: "draft-pat",
        dashboardUserId: 84,
      })
    );
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it("logs the failed PAT probe stage and safe upstream diagnostics", async () => {
    testPatMock.mockResolvedValue({
      ok: false,
      stage: "pricing",
      reason: "auth",
      status: 403,
      error: "PRICING_DISABLED: pricing is disabled",
    });

    const result = await testUpstreamSitePat({
      siteId: 4,
      dashboardPat: "draft-pat-must-not-be-logged",
      dashboardUserId: 84,
      probeBaseUrl: "https://example.com/draft/v1",
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "upstream_site.pat_test_auth",
    });
    expect(loggerWarnMock).toHaveBeenCalledWith("testUpstreamSitePat:failed", {
      siteId: 4,
      siteKey: "example.com",
      reason: "upstream_site.pat_test_auth",
      probeBaseUrl: "https://example.com/draft",
      probeEndpoint: "/api/pricing",
      probeStage: "pricing",
      upstreamReason: "auth",
      upstreamStatus: 403,
      upstreamMessage: "PRICING_DISABLED: pricing is disabled",
    });
    expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain("draft-pat-must-not-be-logged");
  });

  it("rejects a PAT without a numeric new-api user UID", async () => {
    findProbeConfigMock.mockResolvedValue({
      ...makeProbeConfig(),
      dashboardPat: null,
      dashboardUserId: null,
    });

    const result = await saveUpstreamSiteConfig({ siteId: 4, dashboardPat: "new-pat" });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "upstream_site.user_id_required_for_pat",
    });
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it("rejects a new-api user UID without a PAT", async () => {
    findProbeConfigMock.mockResolvedValue({
      ...makeProbeConfig(),
      dashboardPat: null,
      dashboardUserId: null,
    });

    const result = await saveUpstreamSiteConfig({ siteId: 4, dashboardUserId: 84 });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "upstream_site.pat_required_for_user_id",
    });
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it("does not delete a site that still has active providers", async () => {
    deleteSiteMock.mockResolvedValue("in_use");
    const result = await removeUpstreamSite(4);

    expect(result).toMatchObject({ ok: false, errorCode: "upstream_site.in_use" });
  });
});
