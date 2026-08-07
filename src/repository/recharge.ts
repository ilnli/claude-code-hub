import "server-only";

import { randomBytes } from "node:crypto";
import Decimal from "decimal.js-light";
import { and, asc, count, desc, eq, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { keys, paymentConfigVersions, rechargeOrders, users } from "@/drizzle/schema";
import { logger } from "@/lib/logger";
import { createAlipayPrecreatePayment, verifyAlipaySignature } from "@/lib/recharge/alipay";
import {
  calculateAlipayAmount,
  isAmountWithinRange,
  normalizeCreditAmount,
} from "@/lib/recharge/money";
import { buildAlipayNotifyUrl } from "@/lib/recharge/notify-url";
import {
  type RechargePaymentConfigDraft,
  resolveRechargePaymentConfig,
  validateRechargePaymentConfig,
} from "@/lib/recharge/payment-config";
import { getRechargeRetryDelayMs } from "@/lib/recharge/retry";
import { invalidateCachedKey, invalidateCachedUser } from "@/lib/security/api-key-auth-cache";
import { createAuditLogAsync } from "@/repository/audit-log";
import type {
  RechargeAdminOrderList,
  RechargeAvailability,
  RechargeOrderStatus,
  RechargeOrderView,
  RechargePaymentConfigPublic,
} from "@/types/recharge";

const ORDER_EXPIRY_MS = 5 * 60 * 1000;
const CLAIM_LEASE_MS = 2 * 60 * 1000;

type PaymentConfigRow = typeof paymentConfigVersions.$inferSelect;
type RechargeOrderRow = typeof rechargeOrders.$inferSelect;

export class RechargeError extends Error {
  constructor(
    public readonly code: string,
    message = code
  ) {
    super(message);
    this.name = "RechargeError";
  }
}

export type RechargePaymentConfigInput = RechargePaymentConfigDraft;

export interface RechargeAdminOrderFilters {
  status?: RechargeOrderStatus;
  needsManualHandling?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function getRechargePaymentConfig(): Promise<RechargePaymentConfigPublic> {
  const config = await getActivePaymentConfigRow();
  return toPublicConfig(config);
}

export async function updateRechargePaymentConfig(
  input: RechargePaymentConfigInput,
  operatorUserId: number
): Promise<RechargePaymentConfigPublic> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(paymentConfigVersions)
      .where(eq(paymentConfigVersions.isActive, true))
      .limit(1)
      .for("update");

    const hasPrivateKey = Boolean(input.privateKey?.trim());
    const hasAlipayPublicKey = Boolean(input.alipayPublicKey?.trim());
    if (hasPrivateKey !== hasAlipayPublicKey) {
      throw new RechargeError("CONFIG_REQUIRED_FIELDS_MISSING");
    }
    const resolved = resolveRechargePaymentConfig(input, current ?? null);
    try {
      validateRechargePaymentConfig(resolved);
    } catch (error) {
      throw new RechargeError(error instanceof Error ? error.message : "CONFIG_SAVE_FAILED");
    }

    if (current) {
      await tx
        .update(paymentConfigVersions)
        .set({ isActive: false })
        .where(eq(paymentConfigVersions.id, current.id));
    }

    const [next] = await tx
      .insert(paymentConfigVersions)
      .values({
        ...resolved,
        createdByUserId: operatorUserId,
        isActive: true,
      })
      .returning();
    if (!next) throw new RechargeError("CONFIG_SAVE_FAILED");
    // Keep public response conversion inside the transaction. A conversion failure must not
    // make the client observe a failed save after the new version has already committed.
    return toPublicConfig(next);
  });
}

export async function getRechargeAvailability(keyId: number): Promise<RechargeAvailability> {
  await expirePendingRechargeOrders(keyId);
  const [config, key] = await Promise.all([
    getActivePaymentConfigRow(),
    db
      .select({ limitTotalUsd: keys.limitTotalUsd, deletedAt: keys.deletedAt })
      .from(keys)
      .where(eq(keys.id, keyId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  const enabled = Boolean(config?.enabled);
  const keyLimit = key?.deletedAt ? null : (key?.limitTotalUsd ?? null);
  const keyEligible = keyLimit !== null && new Decimal(keyLimit).gt(0);

  return {
    enabled,
    eligible: enabled && keyEligible,
    ineligibleReason: !enabled ? "payment_disabled" : !keyEligible ? "key_limit_required" : null,
    feeRatePercent: config?.feeRatePercent ?? "0.0000",
    minCreditUsd: config?.minCreditUsd ?? "1.00",
    maxCreditUsd: config?.maxCreditUsd ?? "1000.00",
    keyLimitTotalUsd: keyLimit,
  };
}

export async function createRechargeOrder(input: {
  keyId: number;
  userId: number;
  creditUsd: string;
  requestOrigin: string;
}): Promise<RechargeOrderView> {
  const creditUsd = normalizeCreditAmount(input.creditUsd);
  const now = new Date();
  const orderNo = createOrderNo(now);

  const created = await db.transaction(async (tx) => {
    const [key] = await tx
      .select()
      .from(keys)
      .where(eq(keys.id, input.keyId))
      .limit(1)
      .for("update");
    if (!key || key.deletedAt || key.userId !== input.userId) {
      throw new RechargeError("KEY_NOT_FOUND");
    }
    if (key.limitTotalUsd === null || new Decimal(key.limitTotalUsd).lte(0)) {
      throw new RechargeError("KEY_LIMIT_REQUIRED");
    }

    const [user] = await tx
      .select({ id: users.id, name: users.name, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!user || user.deletedAt) throw new RechargeError("USER_NOT_FOUND");

    const [config] = await tx
      .select()
      .from(paymentConfigVersions)
      .where(eq(paymentConfigVersions.isActive, true))
      .limit(1);
    if (!config?.enabled) throw new RechargeError("PAYMENT_DISABLED");
    if (!isAmountWithinRange(creditUsd, config.minCreditUsd, config.maxCreditUsd)) {
      throw new RechargeError("AMOUNT_OUT_OF_RANGE");
    }

    await tx
      .update(rechargeOrders)
      .set({
        status: "cancelled",
        cancellationReason: "expired",
        cancelledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(rechargeOrders.keyId, input.keyId),
          eq(rechargeOrders.status, "pending"),
          lte(rechargeOrders.expiresAt, now)
        )
      );

    const [pending] = await tx
      .select({ id: rechargeOrders.id })
      .from(rechargeOrders)
      .where(and(eq(rechargeOrders.keyId, input.keyId), eq(rechargeOrders.status, "pending")))
      .limit(1);
    if (pending) throw new RechargeError("PENDING_ORDER_EXISTS");

    const paidAmountCny = calculateAlipayAmount(creditUsd, config.feeRatePercent);
    const [order] = await tx
      .insert(rechargeOrders)
      .values({
        orderNo,
        configVersionId: config.id,
        keyId: key.id,
        userId: user.id,
        keyName: key.name,
        userName: user.name,
        status: "pending",
        creditUsd,
        paidAmountCny,
        feeRatePercent: config.feeRatePercent,
        productName: config.productName,
        expiresAt: new Date(now.getTime() + ORDER_EXPIRY_MS),
      })
      .returning();
    if (!order) throw new RechargeError("ORDER_CREATE_FAILED");
    return { order, config };
  });

  try {
    const payment = await createAlipayPrecreatePayment({
      appId: created.config.appId,
      privateKey: created.config.privateKey,
      alipayPublicKey: created.config.alipayPublicKey,
      notifyUrl: buildAlipayNotifyUrl(
        created.config.notifyDomain,
        process.env.APP_URL,
        input.requestOrigin
      ),
      orderNo: created.order.orderNo,
      subject: created.order.productName,
      totalAmount: created.order.paidAmountCny,
    });
    const [updated] = await db
      .update(rechargeOrders)
      .set({ qrCode: payment.qrCode, updatedAt: new Date() })
      .where(and(eq(rechargeOrders.id, created.order.id), eq(rechargeOrders.status, "pending")))
      .returning();
    if (!updated) throw new RechargeError("ORDER_NO_LONGER_PENDING");
    return toOrderView(updated);
  } catch (error) {
    const errorMessage = safeErrorMessage(error);
    logger.error("[Recharge] Alipay precreate failed", {
      orderId: created.order.id,
      orderNo: created.order.orderNo,
      error: errorMessage,
    });
    await db
      .update(rechargeOrders)
      .set({
        status: "cancelled",
        cancellationReason: "payment_creation_failed",
        lastSettlementError: errorMessage,
        cancelledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(rechargeOrders.id, created.order.id), eq(rechargeOrders.status, "pending")));
    if (error instanceof RechargeError) throw error;
    throw new RechargeError(
      "ALIPAY_PRECREATE_FAILED",
      error instanceof Error ? error.message : "ALIPAY_PRECREATE_FAILED"
    );
  }
}

export async function listRechargeOrdersForKey(keyId: number): Promise<RechargeOrderView[]> {
  await expirePendingRechargeOrders(keyId);
  const rows = await db
    .select()
    .from(rechargeOrders)
    .where(eq(rechargeOrders.keyId, keyId))
    .orderBy(desc(rechargeOrders.createdAt), desc(rechargeOrders.id))
    .limit(100);
  return rows.map(toOrderView);
}

export async function getRechargeOrderForKey(
  orderId: number,
  keyId: number
): Promise<RechargeOrderView | null> {
  await expirePendingRechargeOrders(keyId);
  const [row] = await db
    .select()
    .from(rechargeOrders)
    .where(and(eq(rechargeOrders.id, orderId), eq(rechargeOrders.keyId, keyId)))
    .limit(1);
  return row ? toOrderView(row) : null;
}

export async function cancelRechargeOrderForKey(
  orderId: number,
  keyId: number,
  reason = "user_cancelled"
): Promise<RechargeOrderView> {
  const now = new Date();
  const [updated] = await db
    .update(rechargeOrders)
    .set({
      status: "cancelled",
      cancellationReason: reason,
      cancelledAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(rechargeOrders.id, orderId),
        eq(rechargeOrders.keyId, keyId),
        eq(rechargeOrders.status, "pending")
      )
    )
    .returning();
  if (!updated) throw new RechargeError("ORDER_NOT_PENDING");
  return toOrderView(updated);
}

export async function handleAlipayRechargeCallback(
  params: Record<string, string>
): Promise<{ orderId: number; settled: boolean }> {
  for (const field of ["sign", "trade_status", "out_trade_no", "trade_no"] as const) {
    if (!params[field]) throw new RechargeError("CALLBACK_MISSING_FIELD");
  }
  if (params.trade_status !== "TRADE_SUCCESS") {
    throw new RechargeError("CALLBACK_TRADE_NOT_SUCCESS");
  }

  const [joined] = await db
    .select({ order: rechargeOrders, config: paymentConfigVersions })
    .from(rechargeOrders)
    .innerJoin(paymentConfigVersions, eq(rechargeOrders.configVersionId, paymentConfigVersions.id))
    .where(eq(rechargeOrders.orderNo, params.out_trade_no))
    .limit(1);
  if (!joined) throw new RechargeError("ORDER_NOT_FOUND");
  if (!verifyAlipaySignature(params, joined.config.alipayPublicKey)) {
    throw new RechargeError("CALLBACK_INVALID_SIGNATURE");
  }
  if (params.app_id && params.app_id !== joined.config.appId) {
    throw new RechargeError("CALLBACK_APP_ID_MISMATCH");
  }
  if (
    params.total_amount &&
    !new Decimal(params.total_amount).eq(new Decimal(joined.order.paidAmountCny))
  ) {
    throw new RechargeError("CALLBACK_AMOUNT_MISMATCH");
  }

  const prepared = await preparePaidOrder(joined.order.id, params.trade_no);
  if (!prepared.shouldSettle) {
    return { orderId: joined.order.id, settled: prepared.settled };
  }

  try {
    await settleRechargeOrder(joined.order.id);
    return { orderId: joined.order.id, settled: true };
  } catch (error) {
    await recordSettlementFailure(joined.order.id, error, false);
    return { orderId: joined.order.id, settled: false };
  }
}

export async function listRechargeOrdersAdmin(
  filters: RechargeAdminOrderFilters = {}
): Promise<RechargeAdminOrderList> {
  await expirePendingRechargeOrders();
  const conditions = [];
  if (filters.status) conditions.push(eq(rechargeOrders.status, filters.status));
  if (filters.needsManualHandling) {
    conditions.push(
      and(
        eq(rechargeOrders.status, "processing"),
        sql`${rechargeOrders.retryCount} >= 3`,
        isNull(rechargeOrders.nextRetryAt)
      )!
    );
  }
  const search = filters.search?.trim();
  if (search) {
    conditions.push(
      or(
        ilike(rechargeOrders.orderNo, `%${search}%`),
        ilike(rechargeOrders.alipayTradeNo, `%${search}%`),
        ilike(rechargeOrders.keyName, `%${search}%`),
        ilike(rechargeOrders.userName, `%${search}%`)
      )!
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const pageSize = Math.min(Math.max(filters.pageSize ?? 30, 1), 100);
  const page = Math.max(filters.page ?? 1, 1);

  const [rows, totalRows, manualRows] = await Promise.all([
    db
      .select()
      .from(rechargeOrders)
      .where(where)
      .orderBy(desc(rechargeOrders.createdAt), desc(rechargeOrders.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(rechargeOrders).where(where),
    db
      .select({ value: count() })
      .from(rechargeOrders)
      .where(
        and(
          eq(rechargeOrders.status, "processing"),
          sql`${rechargeOrders.retryCount} >= 3`,
          isNull(rechargeOrders.nextRetryAt)
        )
      ),
  ]);
  return {
    items: rows.map(toOrderView),
    total: Number(totalRows[0]?.value ?? 0),
    needsManualHandlingCount: Number(manualRows[0]?.value ?? 0),
  };
}

export async function getRechargeOrderAdmin(orderId: number): Promise<RechargeOrderView | null> {
  const [row] = await db
    .select()
    .from(rechargeOrders)
    .where(eq(rechargeOrders.id, orderId))
    .limit(1);
  return row ? toOrderView(row) : null;
}

export async function adminConfirmRechargeOrder(
  orderId: number,
  operatorUserId: number,
  reason: string
): Promise<RechargeOrderView> {
  await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(rechargeOrders)
      .where(eq(rechargeOrders.id, orderId))
      .limit(1)
      .for("update");
    if (!order) throw new RechargeError("ORDER_NOT_FOUND");
    if (!["pending", "cancelled", "processing"].includes(order.status)) {
      throw new RechargeError("ORDER_CANNOT_CONFIRM");
    }
    await tx
      .update(rechargeOrders)
      .set({
        status: "processing",
        paidAt: order.paidAt ?? new Date(),
        manualReason: reason,
        manualOperatorUserId: operatorUserId,
        nextRetryAt: null,
        updatedAt: new Date(),
      })
      .where(eq(rechargeOrders.id, orderId));
  });
  try {
    await settleRechargeOrder(orderId);
  } catch (error) {
    await recordSettlementFailure(orderId, error, false);
    throw error;
  }
  const order = await getRechargeOrderAdmin(orderId);
  if (!order) throw new RechargeError("ORDER_NOT_FOUND");
  return order;
}

export async function adminRetryRechargeOrder(orderId: number): Promise<RechargeOrderView> {
  try {
    await settleRechargeOrder(orderId);
  } catch (error) {
    await recordSettlementFailure(orderId, error, false);
    throw error;
  }
  const order = await getRechargeOrderAdmin(orderId);
  if (!order) throw new RechargeError("ORDER_NOT_FOUND");
  return order;
}

export async function adminCancelRechargeOrder(
  orderId: number,
  operatorUserId: number,
  reason: string
): Promise<RechargeOrderView> {
  const now = new Date();
  const [updated] = await db
    .update(rechargeOrders)
    .set({
      status: "cancelled",
      cancellationReason: "admin_cancelled",
      manualReason: reason,
      manualOperatorUserId: operatorUserId,
      cancelledAt: now,
      updatedAt: now,
    })
    .where(and(eq(rechargeOrders.id, orderId), eq(rechargeOrders.status, "pending")))
    .returning();
  if (!updated) throw new RechargeError("ORDER_NOT_PENDING");
  return toOrderView(updated);
}

export async function adminCloseRechargeOrder(
  orderId: number,
  operatorUserId: number,
  reason: string
): Promise<RechargeOrderView> {
  const invalidation = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(rechargeOrders)
      .where(eq(rechargeOrders.id, orderId))
      .limit(1)
      .for("update");
    if (!order) throw new RechargeError("ORDER_NOT_FOUND");
    if (!["processing", "completed"].includes(order.status)) {
      throw new RechargeError("ORDER_CANNOT_CLOSE");
    }

    let keyString: string | null = null;
    if (order.status === "completed") {
      const [key] = await tx
        .select()
        .from(keys)
        .where(eq(keys.id, order.keyId))
        .limit(1)
        .for("update");
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, order.userId))
        .limit(1)
        .for("update");
      if (!key || key.deletedAt || !user || user.deletedAt || key.limitTotalUsd === null) {
        throw new RechargeError("REFUND_TARGET_MISSING");
      }

      const nextKeyLimit = new Decimal(key.limitTotalUsd).minus(order.keyCreditAppliedUsd);
      if (nextKeyLimit.lt(0)) throw new RechargeError("REFUND_LIMIT_CONFLICT");
      await tx
        .update(keys)
        .set({ limitTotalUsd: nextKeyLimit.toFixed(2), updatedAt: new Date() })
        .where(eq(keys.id, key.id));
      keyString = key.key;

      if (new Decimal(order.userCreditAppliedUsd).gt(0)) {
        if (user.limitTotalUsd === null) throw new RechargeError("REFUND_LIMIT_CONFLICT");
        const nextUserLimit = new Decimal(user.limitTotalUsd).minus(order.userCreditAppliedUsd);
        if (nextUserLimit.lt(0)) throw new RechargeError("REFUND_LIMIT_CONFLICT");
        await tx
          .update(users)
          .set({ limitTotalUsd: nextUserLimit.toFixed(2), updatedAt: new Date() })
          .where(eq(users.id, user.id));
      }
    }

    const now = new Date();
    await tx
      .update(rechargeOrders)
      .set({
        status: "manual_closed",
        manualReason: reason,
        manualOperatorUserId: operatorUserId,
        nextRetryAt: null,
        closedAt: now,
        updatedAt: now,
      })
      .where(eq(rechargeOrders.id, order.id));
    return { keyString, userId: order.userId };
  });

  if (invalidation.keyString) {
    await Promise.all([
      invalidateCachedKey(invalidation.keyString),
      invalidateCachedUser(invalidation.userId),
    ]);
  }
  const order = await getRechargeOrderAdmin(orderId);
  if (!order) throw new RechargeError("ORDER_NOT_FOUND");
  return order;
}

export async function processDueRechargeSettlements(): Promise<void> {
  await expirePendingRechargeOrders();
  const now = new Date();
  const claimedIds = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: rechargeOrders.id })
      .from(rechargeOrders)
      .where(
        and(
          eq(rechargeOrders.status, "processing"),
          lte(rechargeOrders.nextRetryAt, now),
          sql`${rechargeOrders.retryCount} < 3`
        )
      )
      .orderBy(asc(rechargeOrders.nextRetryAt), asc(rechargeOrders.id))
      .limit(20)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    await tx
      .update(rechargeOrders)
      .set({ nextRetryAt: new Date(now.getTime() + CLAIM_LEASE_MS), updatedAt: now })
      .where(inArray(rechargeOrders.id, ids));
    return ids;
  });

  for (const id of claimedIds) {
    try {
      await settleRechargeOrder(id);
    } catch (error) {
      const result = await recordSettlementFailure(id, error, true);
      if (result.needsAlert) await sendRechargeSettlementAlert(id);
    }
  }
}

export async function countRechargeOrdersNeedingManualHandling(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(rechargeOrders)
    .where(
      and(
        eq(rechargeOrders.status, "processing"),
        sql`${rechargeOrders.retryCount} >= 3`,
        isNull(rechargeOrders.nextRetryAt)
      )
    );
  return Number(row?.value ?? 0);
}

async function settleRechargeOrder(orderId: number): Promise<void> {
  const result = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(rechargeOrders)
      .where(eq(rechargeOrders.id, orderId))
      .limit(1)
      .for("update");
    if (!order) throw new RechargeError("ORDER_NOT_FOUND");
    if (order.status === "completed" || order.status === "manual_closed") {
      return null;
    }
    if (order.status !== "processing") throw new RechargeError("ORDER_NOT_PROCESSING");

    const [key] = await tx
      .select()
      .from(keys)
      .where(eq(keys.id, order.keyId))
      .limit(1)
      .for("update");
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, order.userId))
      .limit(1)
      .for("update");
    if (!key || key.deletedAt || !user || user.deletedAt) {
      throw new RechargeError("SETTLEMENT_TARGET_MISSING");
    }
    if (key.limitTotalUsd === null || new Decimal(key.limitTotalUsd).lte(0)) {
      throw new RechargeError("KEY_LIMIT_NO_LONGER_POSITIVE");
    }

    const credit = new Decimal(order.creditUsd);
    const nextKeyLimit = new Decimal(key.limitTotalUsd).plus(credit).toFixed(2);
    await tx
      .update(keys)
      .set({ limitTotalUsd: nextKeyLimit, updatedAt: new Date() })
      .where(eq(keys.id, key.id));

    let userCreditAppliedUsd = "0.00";
    if (user.limitTotalUsd !== null && new Decimal(user.limitTotalUsd).gt(0)) {
      userCreditAppliedUsd = order.creditUsd;
      await tx
        .update(users)
        .set({
          limitTotalUsd: new Decimal(user.limitTotalUsd).plus(credit).toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
    }

    const now = new Date();
    await tx
      .update(rechargeOrders)
      .set({
        status: "completed",
        keyCreditAppliedUsd: order.creditUsd,
        userCreditAppliedUsd,
        nextRetryAt: null,
        lastSettlementError: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(rechargeOrders.id, order.id));
    return {
      keyString: key.key,
      userId: user.id,
      orderNo: order.orderNo,
      creditUsd: order.creditUsd,
    };
  });

  if (result) {
    await Promise.all([invalidateCachedKey(result.keyString), invalidateCachedUser(result.userId)]);
    void createAuditLogAsync({
      actionCategory: "recharge",
      actionType: "recharge.settlement.complete",
      targetType: "recharge_order",
      targetId: String(orderId),
      afterValue: { orderNo: result.orderNo, creditUsd: result.creditUsd },
      success: true,
    });
  }
}

async function preparePaidOrder(
  orderId: number,
  alipayTradeNo: string
): Promise<{ shouldSettle: boolean; settled: boolean }> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(rechargeOrders)
      .where(eq(rechargeOrders.id, orderId))
      .limit(1)
      .for("update");
    if (!order) throw new RechargeError("ORDER_NOT_FOUND");
    if (order.alipayTradeNo && order.alipayTradeNo !== alipayTradeNo) {
      throw new RechargeError("CALLBACK_TRADE_NO_MISMATCH");
    }
    const [duplicate] = await tx
      .select({ id: rechargeOrders.id })
      .from(rechargeOrders)
      .where(eq(rechargeOrders.alipayTradeNo, alipayTradeNo))
      .limit(1);
    if (duplicate && duplicate.id !== order.id) {
      throw new RechargeError("CALLBACK_TRADE_NO_DUPLICATE");
    }
    if (order.status === "completed") return { shouldSettle: false, settled: true };
    if (order.status === "manual_closed") return { shouldSettle: false, settled: false };

    await tx
      .update(rechargeOrders)
      .set({
        status: "processing",
        alipayTradeNo,
        paidAt: order.paidAt ?? new Date(),
        cancellationReason: null,
        nextRetryAt: null,
        updatedAt: new Date(),
      })
      .where(eq(rechargeOrders.id, order.id));
    return { shouldSettle: true, settled: false };
  });
}

async function recordSettlementFailure(
  orderId: number,
  error: unknown,
  automaticAttempt: boolean
): Promise<{ needsAlert: boolean }> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(rechargeOrders)
      .where(eq(rechargeOrders.id, orderId))
      .limit(1)
      .for("update");
    if (order?.status !== "processing") return { needsAlert: false };

    const retryCount = automaticAttempt ? Math.min(order.retryCount + 1, 3) : order.retryCount;
    const delayMs = getRechargeRetryDelayMs(retryCount, automaticAttempt);
    const exhausted = retryCount >= 3;
    await tx
      .update(rechargeOrders)
      .set({
        retryCount,
        nextRetryAt: exhausted || delayMs === null ? null : new Date(Date.now() + delayMs),
        lastSettlementError: safeErrorMessage(error),
        updatedAt: new Date(),
      })
      .where(eq(rechargeOrders.id, order.id));
    void createAuditLogAsync({
      actionCategory: "recharge",
      actionType: "recharge.settlement.failed",
      targetType: "recharge_order",
      targetId: String(order.id),
      afterValue: { retryCount, nextRetryAt: delayMs === null ? null : "scheduled" },
      success: false,
      errorMessage: safeErrorMessage(error),
    });
    return { needsAlert: automaticAttempt && exhausted && order.alertSentAt === null };
  });
}

async function sendRechargeSettlementAlert(orderId: number): Promise<void> {
  const [settings, order, pendingCount] = await Promise.all([
    import("@/repository/notifications").then(({ getNotificationSettings }) =>
      getNotificationSettings()
    ),
    getRechargeOrderAdmin(orderId),
    countRechargeOrdersNeedingManualHandling(),
  ]);
  if (!order) return;

  try {
    if (settings.enabled && settings.rechargeSettlementAlertEnabled) {
      const [{ getEnabledBindingsByType }, { sendWebhookMessage }] = await Promise.all([
        import("@/repository/notification-bindings"),
        import("@/lib/webhook"),
      ]);
      const bindings = await getEnabledBindingsByType("recharge_settlement_alert");
      const message = {
        header: { title: "Recharge settlement requires manual handling", level: "error" as const },
        sections: [
          {
            content: [
              {
                type: "fields" as const,
                items: [
                  { label: "Order", value: order.orderNo },
                  { label: "Credit", value: `${order.creditUsd} USD` },
                  { label: "Pending manual handling", value: String(pendingCount) },
                  { label: "Last error", value: order.lastSettlementError ?? "Unknown" },
                ],
              },
            ],
          },
        ],
        timestamp: new Date(),
      };
      await Promise.allSettled(
        bindings.map((binding) =>
          sendWebhookMessage(binding.target, message, {
            notificationType: "recharge_settlement_alert",
            data: {
              orderNo: order.orderNo,
              creditUsd: order.creditUsd,
              pendingManualHandlingCount: pendingCount,
              lastError: order.lastSettlementError,
            },
            templateOverride: binding.templateOverride,
            timezone: binding.scheduleTimezone ?? undefined,
          })
        )
      );
    }
  } finally {
    await db
      .update(rechargeOrders)
      .set({ alertSentAt: new Date(), updatedAt: new Date() })
      .where(and(eq(rechargeOrders.id, orderId), isNull(rechargeOrders.alertSentAt)));
  }
}

async function expirePendingRechargeOrders(keyId?: number): Promise<void> {
  const now = new Date();
  const expired = await db
    .update(rechargeOrders)
    .set({
      status: "cancelled",
      cancellationReason: "expired",
      cancelledAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(rechargeOrders.status, "pending"),
        lte(rechargeOrders.expiresAt, now),
        ...(keyId === undefined ? [] : [eq(rechargeOrders.keyId, keyId)])
      )
    )
    .returning({ id: rechargeOrders.id, orderNo: rechargeOrders.orderNo });
  for (const order of expired) {
    void createAuditLogAsync({
      actionCategory: "recharge",
      actionType: "recharge.order.expire",
      targetType: "recharge_order",
      targetId: String(order.id),
      afterValue: { orderNo: order.orderNo },
      success: true,
    });
  }
}

async function getActivePaymentConfigRow(): Promise<PaymentConfigRow | null> {
  const [row] = await db
    .select()
    .from(paymentConfigVersions)
    .where(eq(paymentConfigVersions.isActive, true))
    .limit(1);
  return row ?? null;
}

function toPublicConfig(config: PaymentConfigRow | null): RechargePaymentConfigPublic {
  return {
    id: config?.id ?? null,
    enabled: config?.enabled ?? false,
    appId: config?.appId ?? "",
    privateKeyConfigured: Boolean(config?.privateKey),
    alipayPublicKeyConfigured: Boolean(config?.alipayPublicKey),
    productName: config?.productName ?? "",
    notifyDomain: config?.notifyDomain ?? null,
    feeRatePercent: config?.feeRatePercent ?? "0.0000",
    minCreditUsd: config?.minCreditUsd ?? "1.00",
    maxCreditUsd: config?.maxCreditUsd ?? "1000.00",
    createdAt: config?.createdAt.toISOString() ?? null,
  };
}

function toOrderView(order: RechargeOrderRow): RechargeOrderView {
  return {
    id: order.id,
    orderNo: order.orderNo,
    keyId: order.keyId,
    userId: order.userId,
    keyName: order.keyName,
    userName: order.userName,
    status: order.status,
    creditUsd: order.creditUsd,
    paidAmountCny: order.paidAmountCny,
    feeRatePercent: order.feeRatePercent,
    productName: order.productName,
    qrCode: order.qrCode,
    alipayTradeNo: order.alipayTradeNo,
    retryCount: order.retryCount,
    needsManualHandling:
      order.status === "processing" && order.retryCount >= 3 && order.nextRetryAt === null,
    lastSettlementError: order.lastSettlementError,
    cancellationReason: order.cancellationReason,
    manualReason: order.manualReason,
    expiresAt: order.expiresAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    completedAt: order.completedAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    closedAt: order.closedAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

function createOrderNo(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `RC${stamp}${randomBytes(6).toString("hex").toUpperCase()}`;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}
