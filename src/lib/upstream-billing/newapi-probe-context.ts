import "server-only";

import { buildNewapiBaseUrl } from "@/lib/upstream-billing/newapi-url";
import { findUpstreamSiteProbeConfigForProvider } from "@/repository/upstream-site";
import type { Provider } from "@/types/provider";
import type { NewapiProbeRequestContext } from "./newapi-client";

/**
 * Resolve the site-owned management-plane target. A site without an explicit target remains on
 * the legacy per-Provider URL and proxy path and cannot supply a PAT.
 */
export async function resolveNewapiProbeRequestContext(
  provider: Provider
): Promise<NewapiProbeRequestContext | null> {
  const site = await findUpstreamSiteProbeConfigForProvider(provider);

  if (site?.probeBaseUrl) {
    return {
      baseUrl: site.probeBaseUrl,
      cacheKey: `site:${site.id}:${site.updatedAt.getTime()}`,
      siteId: site.id,
      proxyConfig: {
        id: site.id,
        name: site.siteKey,
        proxyUrl: site.proxyUrl,
        proxyFallbackToDirect: site.proxyFallbackToDirect,
      },
      dashboardPat: site.dashboardPat,
      dashboardUserId: site.dashboardUserId,
    };
  }

  try {
    const baseUrl = buildNewapiBaseUrl(provider.url);
    return {
      baseUrl,
      cacheKey: `legacy:${baseUrl}`,
      siteId: site?.id ?? null,
      proxyConfig: provider,
      dashboardPat: null,
      dashboardUserId: null,
    };
  } catch {
    return null;
  }
}
