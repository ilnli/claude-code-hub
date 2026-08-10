import { buildNewapiBaseUrl } from "@/lib/upstream-billing/newapi-url";

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

export function normalizeUpstreamSiteKey(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname) return null;
    return parsed.port ? `${hostname}:${parsed.port}` : hostname;
  } catch {
    return null;
  }
}

export function normalizeSiteProbeBaseUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return buildNewapiBaseUrl(parsed.toString()).replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function probeTargetMatchesSite(siteKey: string, probeBaseUrl: string): boolean {
  return normalizeUpstreamSiteKey(probeBaseUrl) === siteKey;
}
