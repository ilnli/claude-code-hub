import { describe, expect, it } from "vitest";
import {
  normalizeSiteProbeBaseUrl,
  normalizeUpstreamSiteKey,
  probeTargetMatchesSite,
} from "@/lib/upstream-sites/identity";

describe("upstream site identity", () => {
  it("normalizes scheme, path, case, www, and default ports into one site", () => {
    expect(normalizeUpstreamSiteKey("https://WWW.Example.COM/v1/messages")).toBe("example.com");
    expect(normalizeUpstreamSiteKey("http://example.com:80/api")).toBe("example.com");
    expect(normalizeUpstreamSiteKey("https://example.com:443/other")).toBe("example.com");
  });

  it("keeps subdomains and non-default ports distinct", () => {
    expect(normalizeUpstreamSiteKey("https://api.example.com/v1")).toBe("api.example.com");
    expect(normalizeUpstreamSiteKey("https://example.com:8443/v1")).toBe("example.com:8443");
  });

  it("rejects invalid and non-http provider URLs", () => {
    expect(normalizeUpstreamSiteKey("not-a-url")).toBeNull();
    expect(normalizeUpstreamSiteKey("ftp://example.com/v1")).toBeNull();
  });

  it("normalizes a management target while preserving its path prefix", () => {
    expect(normalizeSiteProbeBaseUrl("https://example.com/gateway/v1/")).toBe(
      "https://example.com/gateway"
    );
    expect(normalizeSiteProbeBaseUrl("https://user:pass@example.com/v1")).toBeNull();
    expect(normalizeSiteProbeBaseUrl("https://example.com/v1?token=x")).toBeNull();
  });

  it("requires the management target to remain on the site host", () => {
    expect(probeTargetMatchesSite("example.com", "https://www.example.com/new-api")).toBe(true);
    expect(probeTargetMatchesSite("example.com", "https://api.example.com/new-api")).toBe(false);
    expect(probeTargetMatchesSite("example.com:8443", "https://example.com:8443")).toBe(true);
  });
});
