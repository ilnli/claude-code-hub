export const RECHARGE_ORDER_STATUSES = [
  "pending",
  "processing",
  "cancelled",
  "completed",
  "manual_closed",
] as const;

export type RechargeOrderStatus = (typeof RECHARGE_ORDER_STATUSES)[number];

export interface RechargePaymentConfigPublic {
  id: number | null;
  enabled: boolean;
  appId: string;
  privateKeyConfigured: boolean;
  alipayPublicKeyConfigured: boolean;
  productName: string;
  notifyDomain: string | null;
  feeRatePercent: string;
  minCreditUsd: string;
  maxCreditUsd: string;
  createdAt: string | null;
}

export interface RechargeOrderView {
  id: number;
  orderNo: string;
  keyId: number;
  userId: number;
  keyName: string;
  userName: string;
  status: RechargeOrderStatus;
  creditUsd: string;
  paidAmountCny: string;
  feeRatePercent: string;
  productName: string;
  qrCode: string | null;
  alipayTradeNo: string | null;
  retryCount: number;
  needsManualHandling: boolean;
  lastSettlementError: string | null;
  cancellationReason: string | null;
  manualReason: string | null;
  expiresAt: string;
  paidAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RechargeAvailability {
  enabled: boolean;
  eligible: boolean;
  ineligibleReason: "payment_disabled" | "key_limit_required" | null;
  feeRatePercent: string;
  minCreditUsd: string;
  maxCreditUsd: string;
  keyLimitTotalUsd: string | null;
}

export interface RechargeAdminOrderList {
  items: RechargeOrderView[];
  total: number;
  needsManualHandlingCount: number;
}
