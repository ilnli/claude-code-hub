import { z } from "@hono/zod-openapi";
import { IsoDateTimeStringSchema, ProviderTypeSchema } from "./_common";

export const ProviderWeightAdjustmentRuleIdParamSchema = z.object({
  id: z.coerce.number().int().positive().describe("Provider weight adjustment rule id."),
});

export const ProviderWeightAdjustmentRunIdParamSchema = z.object({
  runId: z.coerce.number().int().positive().describe("Provider weight adjustment run id."),
});

export const ProviderWeightAdjustmentPreviewRowSchema = z.object({
  providerId: z.number().int().positive(),
  providerName: z.string(),
  providerType: ProviderTypeSchema,
  priority: z.number().int(),
  isEnabled: z.boolean(),
  currentWeight: z.number().int(),
  parsedCostMultiplier: z.number().positive().nullable(),
  projectedWeight: z.number().int().min(1).max(100).nullable(),
  projectedShare: z.number().min(0).max(1).nullable(),
  participates: z.boolean(),
  skipReason: z
    .enum([
      "disabled",
      "type_mismatch",
      "priority_mismatch",
      "invalid_cost",
      "insufficient_participants",
    ])
    .nullable(),
});

export const ProviderWeightAdjustmentPreviewSchema = z.object({
  rows: z.array(ProviderWeightAdjustmentPreviewRowSchema),
  memberCount: z.number().int().min(0),
  participantCount: z.number().int().min(0),
  changedCount: z.number().int().min(0),
  skippedCount: z.number().int().min(0),
  actionable: z.boolean(),
});

export const ProviderWeightAdjustmentRuleSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  description: z.string().nullable(),
  providerType: ProviderTypeSchema,
  priority: z.number().int(),
  isEnabled: z.boolean(),
  revision: z.number().int().positive(),
  nextRunAt: IsoDateTimeStringSchema.nullable(),
  activeRunId: z.number().int().positive().nullable(),
  faultActive: z.boolean(),
  faultKind: z.string().nullable(),
  faultMessage: z.string().nullable(),
  faultStartedAt: IsoDateTimeStringSchema.nullable(),
  lastRunAt: IsoDateTimeStringSchema.nullable(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
  deletedAt: IsoDateTimeStringSchema.nullable(),
  preview: ProviderWeightAdjustmentPreviewSchema,
});

export const ProviderWeightAdjustmentRuleListSchema = z.object({
  items: z.array(ProviderWeightAdjustmentRuleSchema),
});

export const ProviderWeightAdjustmentRuleCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().max(1000).nullable().optional(),
    providerType: ProviderTypeSchema,
    priority: z.number().int(),
    providerIds: z.array(z.number().int().positive()).max(500).default([]),
    isEnabled: z.boolean().optional(),
  })
  .strict();

export const ProviderWeightAdjustmentRuleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    providerType: ProviderTypeSchema.optional(),
    priority: z.number().int().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");

export const ProviderWeightAdjustmentMembersSchema = z
  .object({
    providerIds: z.array(z.number().int().positive()).max(500),
  })
  .strict();

export const ProviderWeightAdjustmentBulkResultSchema = z.object({
  enabledRuleIds: z.array(z.number().int().positive()),
  rejected: z.array(z.object({ ruleId: z.number().int().positive(), code: z.string() })),
});

export const ProviderWeightAdjustmentRunSummarySchema = z.object({
  memberCount: z.number().int().min(0),
  participantCount: z.number().int().min(0),
  changedCount: z.number().int().min(0),
  skippedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
});

export const ProviderWeightAdjustmentRunSchema = z.object({
  id: z.number().int().positive(),
  ruleId: z.number().int().positive(),
  trigger: z.enum(["scheduled", "manual"]),
  status: z.enum(["running", "succeeded", "succeeded_with_warning", "failed", "skipped"]),
  idempotencyKey: z.string().nullable(),
  ruleName: z.string(),
  providerType: ProviderTypeSchema,
  priority: z.number().int(),
  ruleRevision: z.number().int().positive(),
  summary: ProviderWeightAdjustmentRunSummarySchema,
  errorMessage: z.string().nullable(),
  startedAt: IsoDateTimeStringSchema,
  completedAt: IsoDateTimeStringSchema.nullable(),
  expiresAt: IsoDateTimeStringSchema,
});

export const ProviderWeightAdjustmentRunListSchema = z.object({
  items: z.array(ProviderWeightAdjustmentRunSchema),
});

export const ProviderWeightAdjustmentRunDetailSchema = z.object({
  id: z.number().int().positive(),
  runId: z.number().int().positive(),
  providerId: z.number().int().positive(),
  providerName: z.string(),
  outcome: z.enum(["changed", "skipped", "failed"]),
  costMultiplier: z.string().nullable(),
  previousWeight: z.number().int(),
  projectedWeight: z.number().int().nullable(),
  reason: z.string().nullable(),
  createdAt: IsoDateTimeStringSchema,
});

export const ProviderWeightAdjustmentRunDetailListSchema = z.object({
  items: z.array(ProviderWeightAdjustmentRunDetailSchema),
});

export const ProviderWeightAdjustmentSettingsSchema = z.object({
  intervalMinutes: z
    .number()
    .int()
    .refine((value) => [10, 30, 60, 360, 1440].includes(value)),
});

export const ProviderWeightAdjustmentRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ProviderWeightAdjustmentRuleCreateInput = z.infer<
  typeof ProviderWeightAdjustmentRuleCreateSchema
>;
export type ProviderWeightAdjustmentRuleUpdateInput = z.infer<
  typeof ProviderWeightAdjustmentRuleUpdateSchema
>;
