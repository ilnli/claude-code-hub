"use server";

import { z } from "zod";
import { redactUrlCredentials } from "@/lib/api/v1/_shared/redaction";
import { emitActionAudit } from "@/lib/audit/emit";
import { getSession } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { isValidProxyUrl } from "@/lib/proxy-agent";
import {
  type NewapiProbeRequestContext,
  testNewapiDashboardPat,
} from "@/lib/upstream-billing/newapi-client";
import { invalidateNewapiRatioTableCacheForSite } from "@/lib/upstream-billing/newapi-table-cache";
import { normalizeSiteProbeBaseUrl, probeTargetMatchesSite } from "@/lib/upstream-sites/identity";
import {
  deleteEmptyUpstreamSite,
  findUpstreamSiteProbeConfigById,
  findUpstreamSites,
  updateUpstreamSiteConfig,
} from "@/repository/upstream-site";
import type { Provider, UpstreamSite } from "@/types/provider";
import type { ActionResult } from "./types";

const SiteIdSchema = z.number().int().positive();
const SiteConfigSchema = z.object({
  siteId: SiteIdSchema,
  probeBaseUrl: z.string().trim().max(2048).optional().nullable(),
  dashboardPat: z.string().trim().min(1).max(4096).optional().nullable(),
  allowInsecureHttp: z.boolean().optional(),
  proxyUrl: z.string().trim().max(2048).optional().nullable(),
  proxyFallbackToDirect: z.boolean().optional(),
});

export type UpstreamSiteConfigInput = z.infer<typeof SiteConfigSchema>;

class SiteConfigError extends Error {
  constructor(
    readonly errorCode: string,
    message: string
  ) {
    super(message);
  }
}

async function requireAdmin(): Promise<boolean> {
  const session = await getSession();
  return session?.user.role === "admin";
}

function sanitizeSite(site: UpstreamSite): UpstreamSite {
  return {
    id: site.id,
    siteKey: site.siteKey,
    probeBaseUrl: site.probeBaseUrl,
    patConfigured: site.patConfigured,
    allowInsecureHttp: site.allowInsecureHttp,
    proxyUrl: redactUrlCredentials(site.proxyUrl),
    proxyFallbackToDirect: site.proxyFallbackToDirect,
    providerCount: site.providerCount,
    newapiProviderCount: site.newapiProviderCount,
    probeTargetCandidates: site.probeTargetCandidates,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

function preserveRedactedProxyEcho(
  incoming: string | null,
  existing: string | null
): string | null {
  if (!incoming || !existing) return incoming;
  return redactUrlCredentials(existing) === incoming ? existing : incoming;
}

function resolveConfig(
  input: UpstreamSiteConfigInput,
  current: Awaited<ReturnType<typeof findUpstreamSiteProbeConfigById>>
) {
  if (!current) throw new SiteConfigError("upstream_site.not_found", "Upstream site not found");

  const rawTarget =
    input.probeBaseUrl === undefined ? current.probeBaseUrl : input.probeBaseUrl?.trim() || null;
  const probeBaseUrl = rawTarget ? normalizeSiteProbeBaseUrl(rawTarget) : null;
  if (rawTarget && !probeBaseUrl) {
    throw new SiteConfigError("upstream_site.invalid_target", "Invalid probe target URL");
  }
  if (probeBaseUrl && !probeTargetMatchesSite(current.siteKey, probeBaseUrl)) {
    throw new SiteConfigError(
      "upstream_site.target_host_mismatch",
      "Probe target host does not match the upstream site"
    );
  }

  const allowInsecureHttp = input.allowInsecureHttp ?? current.allowInsecureHttp;
  if (probeBaseUrl?.startsWith("http:") && !allowInsecureHttp) {
    throw new SiteConfigError(
      "upstream_site.insecure_http_not_allowed",
      "HTTP probe targets require explicit insecure HTTP permission"
    );
  }

  const dashboardPat =
    input.dashboardPat === undefined ? current.dashboardPat : input.dashboardPat?.trim() || null;
  if (dashboardPat && !probeBaseUrl) {
    throw new SiteConfigError(
      "upstream_site.target_required_for_pat",
      "A probe target is required before configuring a PAT"
    );
  }

  const incomingProxy =
    input.proxyUrl === undefined ? current.proxyUrl : input.proxyUrl?.trim() || null;
  const proxyUrl = preserveRedactedProxyEcho(incomingProxy, current.proxyUrl);
  if (proxyUrl && !isValidProxyUrl(proxyUrl)) {
    throw new SiteConfigError("upstream_site.invalid_proxy", "Invalid proxy URL");
  }

  return {
    probeBaseUrl,
    dashboardPat,
    allowInsecureHttp,
    proxyUrl,
    proxyFallbackToDirect: input.proxyFallbackToDirect ?? current.proxyFallbackToDirect,
  };
}

function actionError(error: unknown): ActionResult<never> {
  if (error instanceof SiteConfigError) {
    return { ok: false, error: error.message, errorCode: error.errorCode };
  }
  return { ok: false, error: "Upstream site operation failed", errorCode: "operation_failed" };
}

export async function getUpstreamSites(): Promise<ActionResult<{ sites: UpstreamSite[] }>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access required", errorCode: "unauthorized" };
  }
  try {
    const sites = (await findUpstreamSites()).map(sanitizeSite);
    return { ok: true, data: { sites } };
  } catch (error) {
    logger.error("getUpstreamSites:error", error);
    return actionError(error);
  }
}

export async function saveUpstreamSiteConfig(
  rawInput: UpstreamSiteConfigInput
): Promise<ActionResult<{ site: UpstreamSite }>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access required", errorCode: "unauthorized" };
  }

  const parsed = SiteConfigSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: "Invalid upstream site configuration", errorCode: "invalid_input" };
  }

  const current = await findUpstreamSiteProbeConfigById(parsed.data.siteId);
  try {
    const config = resolveConfig(parsed.data, current);
    if (!current) throw new SiteConfigError("upstream_site.not_found", "Upstream site not found");

    const site = await updateUpstreamSiteConfig(current.id, config);
    if (!site) throw new SiteConfigError("upstream_site.not_found", "Upstream site not found");
    invalidateNewapiRatioTableCacheForSite(current.id);

    const patChanged = parsed.data.dashboardPat !== undefined;
    const upstreamSiteAuditAction = !patChanged
      ? "upstream_site.update"
      : !current.dashboardPat && config.dashboardPat
        ? "upstream_site.pat.set"
        : current.dashboardPat && !config.dashboardPat
          ? "upstream_site.pat.clear"
          : "upstream_site.pat.replace";
    emitActionAudit({
      category: "provider",
      action: upstreamSiteAuditAction,
      targetType: "upstream_site",
      targetId: current.id,
      targetName: current.siteKey,
      before: {
        probeBaseUrl: current.probeBaseUrl,
        patConfigured: Boolean(current.dashboardPat),
        allowInsecureHttp: current.allowInsecureHttp,
        proxyUrl: redactUrlCredentials(current.proxyUrl),
        proxyFallbackToDirect: current.proxyFallbackToDirect,
      },
      after: {
        probeBaseUrl: config.probeBaseUrl,
        patConfigured: Boolean(config.dashboardPat),
        allowInsecureHttp: config.allowInsecureHttp,
        proxyUrl: redactUrlCredentials(config.proxyUrl),
        proxyFallbackToDirect: config.proxyFallbackToDirect,
      },
      success: true,
      redactExtraKeys: ["dashboardPat"],
    });
    return { ok: true, data: { site: sanitizeSite(site) } };
  } catch (error) {
    emitActionAudit({
      category: "provider",
      action: "upstream_site.update",
      targetType: "upstream_site",
      targetId: parsed.data.siteId,
      targetName: current?.siteKey,
      success: false,
      errorMessage: error instanceof SiteConfigError ? error.errorCode : "operation_failed",
      redactExtraKeys: ["dashboardPat"],
    });
    logger.error("saveUpstreamSiteConfig:error", {
      siteId: parsed.data.siteId,
      reason:
        error instanceof SiteConfigError
          ? error.errorCode
          : error instanceof Error
            ? error.name
            : "unknown_error",
    });
    return actionError(error);
  }
}

export async function testUpstreamSitePat(
  rawInput: UpstreamSiteConfigInput
): Promise<ActionResult<{ groupCount: number }>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access required", errorCode: "unauthorized" };
  }

  const parsed = SiteConfigSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: "Invalid upstream site configuration", errorCode: "invalid_input" };
  }
  const current = await findUpstreamSiteProbeConfigById(parsed.data.siteId);

  try {
    const config = resolveConfig(parsed.data, current);
    if (!current || !config.probeBaseUrl || !config.dashboardPat) {
      throw new SiteConfigError(
        "upstream_site.pat_and_target_required",
        "A probe target and PAT are required for testing"
      );
    }

    const proxyConfig = {
      id: current.id,
      name: current.siteKey,
      proxyUrl: config.proxyUrl,
      proxyFallbackToDirect: config.proxyFallbackToDirect,
    };
    const context: NewapiProbeRequestContext = {
      baseUrl: config.probeBaseUrl,
      cacheKey: `test:${current.id}`,
      siteId: current.id,
      proxyConfig,
      dashboardPat: config.dashboardPat,
    };
    const probeProvider = {
      ...proxyConfig,
      url: config.probeBaseUrl,
      key: "",
    } as Provider;
    const result = await testNewapiDashboardPat(probeProvider, context);
    if (!result.ok) {
      throw new SiteConfigError(
        `upstream_site.pat_test_${result.reason}`,
        result.error ?? `PAT test failed (${result.reason})`
      );
    }

    emitActionAudit({
      category: "provider",
      action: "upstream_site.pat.test",
      targetType: "upstream_site",
      targetId: current.id,
      targetName: current.siteKey,
      after: { groupCount: result.groupCount },
      success: true,
      redactExtraKeys: ["dashboardPat"],
    });
    return { ok: true, data: { groupCount: result.groupCount } };
  } catch (error) {
    emitActionAudit({
      category: "provider",
      action: "upstream_site.pat.test",
      targetType: "upstream_site",
      targetId: parsed.data.siteId,
      targetName: current?.siteKey,
      success: false,
      errorMessage: error instanceof SiteConfigError ? error.errorCode : "operation_failed",
      redactExtraKeys: ["dashboardPat"],
    });
    logger.warn("testUpstreamSitePat:failed", {
      siteId: parsed.data.siteId,
      reason: error instanceof SiteConfigError ? error.errorCode : "operation_failed",
    });
    return actionError(error);
  }
}

export async function removeUpstreamSite(siteId: number): Promise<ActionResult<{ deleted: true }>> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Admin access required", errorCode: "unauthorized" };
  }
  const parsed = SiteIdSchema.safeParse(siteId);
  if (!parsed.success) {
    return { ok: false, error: "Invalid upstream site id", errorCode: "invalid_input" };
  }

  const current = await findUpstreamSiteProbeConfigById(parsed.data);
  try {
    const result = await deleteEmptyUpstreamSite(parsed.data);
    if (result === "missing") {
      throw new SiteConfigError("upstream_site.not_found", "Upstream site not found");
    }
    if (result === "in_use") {
      throw new SiteConfigError(
        "upstream_site.in_use",
        "Upstream sites with active providers cannot be deleted"
      );
    }
    invalidateNewapiRatioTableCacheForSite(parsed.data);
    emitActionAudit({
      category: "provider",
      action: "upstream_site.delete",
      targetType: "upstream_site",
      targetId: parsed.data,
      targetName: current?.siteKey,
      before: current
        ? {
            probeBaseUrl: current.probeBaseUrl,
            patConfigured: Boolean(current.dashboardPat),
            proxyUrl: redactUrlCredentials(current.proxyUrl),
          }
        : undefined,
      success: true,
      redactExtraKeys: ["dashboardPat"],
    });
    return { ok: true, data: { deleted: true } };
  } catch (error) {
    emitActionAudit({
      category: "provider",
      action: "upstream_site.delete",
      targetType: "upstream_site",
      targetId: parsed.data,
      targetName: current?.siteKey,
      success: false,
      errorMessage: error instanceof SiteConfigError ? error.errorCode : "operation_failed",
    });
    return actionError(error);
  }
}
