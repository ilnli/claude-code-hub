import { z } from "@hono/zod-openapi";

export const UpstreamSiteIdParamSchema = z.object({
  id: z.coerce.number().int().positive().describe("Upstream site id."),
});

export const UpstreamSiteSchema = z.object({
  id: z.number().int().positive(),
  siteKey: z.string(),
  probeBaseUrl: z.string().url().nullable(),
  patConfigured: z.boolean(),
  dashboardUserId: z.number().int().positive().max(2_147_483_647).nullable(),
  allowInsecureHttp: z.boolean(),
  proxyUrl: z.string().nullable().describe("Proxy URL with credentials redacted."),
  proxyFallbackToDirect: z.boolean(),
  providerCount: z.number().int().min(0),
  newapiProviderCount: z.number().int().min(0),
  probeTargetCandidates: z.array(z.string().url()),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export const UpstreamSiteListResponseSchema = z.object({
  items: z.array(UpstreamSiteSchema),
});

export const UpstreamSiteConfigSchema = z
  .object({
    probeBaseUrl: z.string().trim().url().max(2048).nullable().optional(),
    dashboardPat: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .nullable()
      .optional()
      .describe("Write-only new-api dashboard PAT. Omit to preserve it and use null to clear it."),
    dashboardUserId: z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .nullable()
      .optional()
      .describe("new-api user UID sent through the New-Api-User header."),
    allowInsecureHttp: z.boolean().optional(),
    proxyUrl: z.string().trim().max(2048).nullable().optional(),
    proxyFallbackToDirect: z.boolean().optional(),
  })
  .strict();

export const UpstreamSitePatTestSchema = UpstreamSiteConfigSchema;

export const UpstreamSitePatTestResponseSchema = z.object({
  groupCount: z.number().int().min(0),
});

export type UpstreamSiteConfigInput = z.infer<typeof UpstreamSiteConfigSchema>;
