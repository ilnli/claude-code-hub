import { z } from "@hono/zod-openapi";
import { RECHARGE_ORDER_STATUSES } from "@/types/recharge";
import { IsoDateTimeStringSchema } from "./_common";

const MoneySchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  .describe("Decimal amount with at most two fractional digits.");

const FeePercentSchema = z
  .string()
  .regex(/^(?:\d{1,2})(?:\.\d{1,4})?$/)
  .describe("Percentage from 0 inclusive to 100 exclusive.");

export const RechargeOrderStatusSchema = z.enum(RECHARGE_ORDER_STATUSES);

export const RechargeOrderSchema = z.object({
  id: z.number().int().positive(),
  orderNo: z.string(),
  keyId: z.number().int().positive(),
  userId: z.number().int().positive(),
  keyName: z.string(),
  userName: z.string(),
  status: RechargeOrderStatusSchema,
  creditUsd: MoneySchema,
  paidAmountCny: MoneySchema,
  feeRatePercent: z.string(),
  productName: z.string(),
  qrCode: z.string().nullable(),
  alipayTradeNo: z.string().nullable(),
  retryCount: z.number().int().nonnegative(),
  needsManualHandling: z.boolean(),
  lastSettlementError: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  manualReason: z.string().nullable(),
  expiresAt: IsoDateTimeStringSchema,
  paidAt: IsoDateTimeStringSchema.nullable(),
  completedAt: IsoDateTimeStringSchema.nullable(),
  cancelledAt: IsoDateTimeStringSchema.nullable(),
  closedAt: IsoDateTimeStringSchema.nullable(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
});

export const RechargeAvailabilitySchema = z.object({
  enabled: z.boolean(),
  eligible: z.boolean(),
  ineligibleReason: z.enum(["payment_disabled", "key_limit_required"]).nullable(),
  feeRatePercent: z.string(),
  minCreditUsd: MoneySchema,
  maxCreditUsd: MoneySchema,
  keyLimitTotalUsd: z.string().nullable(),
});

export const RechargeOrderListSchema = z.object({ items: z.array(RechargeOrderSchema) });

export const RechargeOrderCreateSchema = z.object({ creditUsd: MoneySchema }).strict();

export const RechargeOrderIdParamSchema = z.object({
  orderId: z.coerce.number().int().positive(),
});

export const RechargePaymentConfigSchema = z.object({
  id: z.number().int().positive().nullable(),
  enabled: z.boolean(),
  appId: z.string(),
  privateKeyConfigured: z.boolean(),
  alipayPublicKeyConfigured: z.boolean(),
  productName: z.string(),
  notifyDomain: z.string().nullable(),
  feeRatePercent: z.string(),
  minCreditUsd: MoneySchema,
  maxCreditUsd: MoneySchema,
  createdAt: IsoDateTimeStringSchema.nullable(),
});

export const RechargePaymentConfigUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    appId: z.string().trim().max(64).optional(),
    privateKey: z.string().trim().optional(),
    alipayPublicKey: z.string().trim().optional(),
    productName: z.string().trim().max(256).optional(),
    notifyDomain: z.string().trim().url().nullable().optional(),
    feeRatePercent: FeePercentSchema.optional(),
    minCreditUsd: MoneySchema.optional(),
    maxCreditUsd: MoneySchema.optional(),
  })
  .strict();

export const RechargeAdminOrderQuerySchema = z.object({
  status: RechargeOrderStatusSchema.optional(),
  needsManualHandling: z.enum(["true", "false"]).optional(),
  search: z.string().trim().max(128).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

export const RechargeAdminOrderListSchema = z.object({
  items: z.array(RechargeOrderSchema),
  total: z.number().int().nonnegative(),
  needsManualHandlingCount: z.number().int().nonnegative(),
});

export const RechargeAdminReasonSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
