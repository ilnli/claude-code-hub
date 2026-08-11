import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { providers, upstreamSites } from "@/drizzle/schema";
import { buildNewapiBaseUrl } from "@/lib/upstream-billing/newapi-url";
import { normalizeUpstreamSiteKey } from "@/lib/upstream-sites/identity";
import type { Provider, UpstreamSite } from "@/types/provider";

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QueryExecutor = Pick<TransactionExecutor, "select" | "insert" | "update" | "delete">;

export interface UpstreamSiteProbeConfig {
  id: number;
  siteKey: string;
  probeBaseUrl: string | null;
  dashboardPat: string | null;
  dashboardUserId: number | null;
  allowInsecureHttp: boolean;
  proxyUrl: string | null;
  proxyFallbackToDirect: boolean;
  updatedAt: Date;
}

export interface UpdateUpstreamSiteConfig {
  probeBaseUrl?: string | null;
  dashboardPat?: string | null;
  dashboardUserId?: number | null;
  allowInsecureHttp?: boolean;
  proxyUrl?: string | null;
  proxyFallbackToDirect?: boolean;
}

function toProbeConfig(row: typeof upstreamSites.$inferSelect): UpstreamSiteProbeConfig {
  return {
    id: row.id,
    siteKey: row.siteKey,
    probeBaseUrl: row.probeBaseUrl ?? null,
    dashboardPat: row.dashboardPat ?? null,
    dashboardUserId: row.dashboardUserId ?? null,
    allowInsecureHttp: row.allowInsecureHttp,
    proxyUrl: row.proxyUrl ?? null,
    proxyFallbackToDirect: row.proxyFallbackToDirect,
    updatedAt: row.updatedAt,
  };
}

async function loadSiteProviderData(): Promise<{
  counts: Map<number, { providerCount: number; newapiProviderCount: number }>;
  candidates: Map<number, string[]>;
}> {
  const rows = await db
    .select({
      upstreamSiteId: providers.upstreamSiteId,
      url: providers.url,
      isEnabled: providers.isEnabled,
      rateFollowUpstream: providers.rateFollowUpstream,
      rateUpstreamType: providers.rateUpstreamType,
    })
    .from(providers)
    .where(and(isNull(providers.deletedAt), sql`${providers.upstreamSiteId} IS NOT NULL`));

  const counts = new Map<number, { providerCount: number; newapiProviderCount: number }>();
  const candidateSets = new Map<number, Set<string>>();
  for (const row of rows) {
    if (row.upstreamSiteId == null) continue;
    const count = counts.get(row.upstreamSiteId) ?? { providerCount: 0, newapiProviderCount: 0 };
    count.providerCount += 1;
    if (row.isEnabled && row.rateFollowUpstream && row.rateUpstreamType === "newapi") {
      count.newapiProviderCount += 1;
    }
    counts.set(row.upstreamSiteId, count);

    try {
      const candidate = buildNewapiBaseUrl(row.url);
      const set = candidateSets.get(row.upstreamSiteId) ?? new Set<string>();
      set.add(candidate);
      candidateSets.set(row.upstreamSiteId, set);
    } catch {
      // Invalid legacy URLs remain visible through the unassigned-provider flow.
    }
  }

  return {
    counts,
    candidates: new Map(
      Array.from(candidateSets, ([id, values]) => [id, Array.from(values).sort()])
    ),
  };
}

function toPublicSite(
  row: typeof upstreamSites.$inferSelect,
  providerData: Awaited<ReturnType<typeof loadSiteProviderData>>
): UpstreamSite {
  const counts = providerData.counts.get(row.id) ?? { providerCount: 0, newapiProviderCount: 0 };
  return {
    id: row.id,
    siteKey: row.siteKey,
    probeBaseUrl: row.probeBaseUrl ?? null,
    patConfigured: Boolean(row.dashboardPat),
    dashboardUserId: row.dashboardUserId ?? null,
    allowInsecureHttp: row.allowInsecureHttp,
    proxyUrl: row.proxyUrl ?? null,
    proxyFallbackToDirect: row.proxyFallbackToDirect,
    ...counts,
    probeTargetCandidates: providerData.candidates.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getOrCreateUpstreamSiteIdForUrl(
  providerUrl: string,
  options: { tx?: QueryExecutor } = {}
): Promise<number | null> {
  const siteKey = normalizeUpstreamSiteKey(providerUrl);
  if (!siteKey) return null;
  const executor = options.tx ?? db;

  const inserted = await executor
    .insert(upstreamSites)
    .values({ siteKey })
    .onConflictDoNothing({ target: upstreamSites.siteKey })
    .returning({ id: upstreamSites.id });
  if (inserted[0]) return inserted[0].id;

  const existing = await executor
    .select({ id: upstreamSites.id })
    .from(upstreamSites)
    .where(eq(upstreamSites.siteKey, siteKey))
    .for("update")
    .limit(1);
  return existing[0]?.id ?? null;
}

export async function backfillUpstreamSitesFromProviders(): Promise<{
  sitesCreated: number;
  providersUpdated: number;
  invalidProviders: number;
}> {
  const rows = await db
    .select({ id: providers.id, url: providers.url, upstreamSiteId: providers.upstreamSiteId })
    .from(providers)
    .where(isNull(providers.deletedAt));

  let sitesCreated = 0;
  let providersUpdated = 0;
  let invalidProviders = 0;
  await db.transaction(async (tx) => {
    const idsByKey = new Map<string, number[]>();
    for (const row of rows) {
      const siteKey = normalizeUpstreamSiteKey(row.url);
      if (!siteKey) {
        invalidProviders += 1;
        continue;
      }
      const ids = idsByKey.get(siteKey) ?? [];
      ids.push(row.id);
      idsByKey.set(siteKey, ids);
    }

    for (const [siteKey, providerIds] of idsByKey) {
      const inserted = await tx
        .insert(upstreamSites)
        .values({ siteKey })
        .onConflictDoNothing({ target: upstreamSites.siteKey })
        .returning({ id: upstreamSites.id });
      if (inserted[0]) sitesCreated += 1;
      const siteId =
        inserted[0]?.id ??
        (
          await tx
            .select({ id: upstreamSites.id })
            .from(upstreamSites)
            .where(eq(upstreamSites.siteKey, siteKey))
            .limit(1)
        )[0]?.id;
      if (siteId == null) continue;

      const updated = await tx
        .update(providers)
        .set({ upstreamSiteId: siteId })
        .where(
          and(
            inArray(providers.id, providerIds),
            sql`${providers.upstreamSiteId} IS DISTINCT FROM ${siteId}`
          )
        )
        .returning({ id: providers.id });
      providersUpdated += updated.length;
    }
  });

  return { sitesCreated, providersUpdated, invalidProviders };
}

export async function findUpstreamSites(): Promise<UpstreamSite[]> {
  const [rows, providerData] = await Promise.all([
    db.select().from(upstreamSites).orderBy(upstreamSites.siteKey),
    loadSiteProviderData(),
  ]);
  return rows.map((row) => toPublicSite(row, providerData));
}

export async function findUpstreamSiteById(id: number): Promise<UpstreamSite | null> {
  const [row, providerData] = await Promise.all([
    db.select().from(upstreamSites).where(eq(upstreamSites.id, id)).limit(1),
    loadSiteProviderData(),
  ]);
  return row[0] ? toPublicSite(row[0], providerData) : null;
}

export async function findUpstreamSiteProbeConfigById(
  id: number
): Promise<UpstreamSiteProbeConfig | null> {
  const rows = await db.select().from(upstreamSites).where(eq(upstreamSites.id, id)).limit(1);
  return rows[0] ? toProbeConfig(rows[0]) : null;
}

export async function findUpstreamSiteProbeConfigForProvider(
  provider: Pick<Provider, "upstreamSiteId" | "url">
): Promise<UpstreamSiteProbeConfig | null> {
  if (provider.upstreamSiteId != null) {
    return findUpstreamSiteProbeConfigById(provider.upstreamSiteId);
  }
  const siteKey = normalizeUpstreamSiteKey(provider.url);
  if (!siteKey) return null;
  const rows = await db
    .select()
    .from(upstreamSites)
    .where(eq(upstreamSites.siteKey, siteKey))
    .limit(1);
  return rows[0] ? toProbeConfig(rows[0]) : null;
}

export async function updateUpstreamSiteConfig(
  id: number,
  patch: UpdateUpstreamSiteConfig
): Promise<UpstreamSite | null> {
  const rows = await db
    .update(upstreamSites)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(upstreamSites.id, id))
    .returning({ id: upstreamSites.id });
  return rows[0] ? findUpstreamSiteById(rows[0].id) : null;
}

export async function deleteEmptyUpstreamSite(
  id: number
): Promise<"deleted" | "in_use" | "missing"> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: upstreamSites.id })
      .from(upstreamSites)
      .where(eq(upstreamSites.id, id))
      .for("update")
      .limit(1);
    if (!existing[0]) return "missing";

    const activeProvider = await tx
      .select({ id: providers.id })
      .from(providers)
      .where(and(eq(providers.upstreamSiteId, id), isNull(providers.deletedAt)))
      .limit(1);
    if (activeProvider[0]) return "in_use";

    await tx.delete(upstreamSites).where(eq(upstreamSites.id, id));
    return "deleted";
  });
}

export async function tryDeleteUnconfiguredUpstreamSiteIfEmpty(id: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(upstreamSites)
      .where(eq(upstreamSites.id, id))
      .for("update")
      .limit(1);
    const site = rows[0];
    if (!site) return false;
    if (
      site.probeBaseUrl ||
      site.dashboardPat ||
      site.dashboardUserId != null ||
      site.proxyUrl ||
      site.allowInsecureHttp ||
      site.proxyFallbackToDirect
    ) {
      return false;
    }

    const activeProvider = await tx
      .select({ id: providers.id })
      .from(providers)
      .where(and(eq(providers.upstreamSiteId, id), isNull(providers.deletedAt)))
      .limit(1);
    if (activeProvider[0]) return false;
    await tx.delete(upstreamSites).where(eq(upstreamSites.id, id));
    return true;
  });
}
