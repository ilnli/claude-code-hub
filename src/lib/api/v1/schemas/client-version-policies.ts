import { z } from "@hono/zod-openapi";
import { IsoDateTimeStringSchema } from "./_common";

export const ClientVersionPolicyModeSchema = z.enum([
  "automatic_baseline",
  "minimum",
  "maximum",
  "range",
  "baseline_lag",
]);

const VersionInputSchema = z.string().trim().min(1).max(64).describe("Client version value.");

export const ClientVersionPolicyWriteSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic_baseline") }).strict(),
  z.object({ mode: z.literal("minimum"), minimumVersion: VersionInputSchema }).strict(),
  z.object({ mode: z.literal("maximum"), maximumVersion: VersionInputSchema }).strict(),
  z
    .object({
      mode: z.literal("range"),
      minimumVersion: VersionInputSchema,
      maximumVersion: VersionInputSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("baseline_lag"),
      baselineLag: z.number().int().positive(),
      previousSeriesTerminalVersion: VersionInputSchema.nullable().optional(),
    })
    .strict(),
]);

export const ClientVersionPolicySchema = z.object({
  id: z.number().int().positive(),
  clientType: z.string(),
  mode: ClientVersionPolicyModeSchema,
  minimumVersion: z.string().nullable(),
  maximumVersion: z.string().nullable(),
  baselineLag: z.number().int().positive().nullable(),
  automaticBaseline: z.string().nullable(),
  previousSeriesTerminalVersion: z.string().nullable(),
  baselineUpdatedAt: IsoDateTimeStringSchema.nullable(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
});

export const ClientVersionPolicyListResponseSchema = z.object({
  items: z.array(ClientVersionPolicySchema),
});

export const ClientVersionPolicyCreateSchema = z
  .object({
    clientType: z.string().trim().min(1).max(128),
    policy: ClientVersionPolicyWriteSchema,
  })
  .strict();

export const ClientVersionPolicyUpdateSchema = ClientVersionPolicyWriteSchema;

export const ClientVersionPolicyClientTypeParamSchema = z.object({
  clientType: z.string().trim().min(1).max(128),
});

export const ClientVersionPolicyOverrideSchema = z
  .object({ selectedVersion: VersionInputSchema })
  .strict();

export const ClientVersionPolicyBulkCreateResponseSchema = z.object({
  items: z.array(ClientVersionPolicySchema),
  createdCount: z.number().int().nonnegative(),
});

export type ClientVersionPolicyWriteInput = z.infer<typeof ClientVersionPolicyWriteSchema>;
export type ClientVersionPolicyCreateInput = z.infer<typeof ClientVersionPolicyCreateSchema>;
