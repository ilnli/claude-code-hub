import type {
  RechargeAdminOrderList,
  RechargeAvailability,
  RechargeOrderStatus,
  RechargeOrderView,
  RechargePaymentConfigPublic,
} from "@/types/recharge";
import { apiClient } from "../client";

export function getRechargeAvailability() {
  return apiClient.get<RechargeAvailability>("/api/v1/recharge/availability");
}

export function listMyRechargeOrders() {
  return apiClient.get<{ items: RechargeOrderView[] }>("/api/v1/recharge/orders");
}

export function getMyRechargeOrder(orderId: number) {
  return apiClient.get<RechargeOrderView>(`/api/v1/recharge/orders/${orderId}`);
}

export function createMyRechargeOrder(creditUsd: string) {
  return apiClient.post<RechargeOrderView>("/api/v1/recharge/orders", { creditUsd });
}

export function cancelMyRechargeOrder(orderId: number) {
  return apiClient.post<RechargeOrderView>(`/api/v1/recharge/orders/${orderId}:cancel`);
}

export function getRechargePaymentConfig() {
  return apiClient.get<RechargePaymentConfigPublic>("/api/v1/recharge/config");
}

export function updateRechargePaymentConfig(input: {
  enabled?: boolean;
  appId?: string;
  privateKey?: string;
  alipayPublicKey?: string;
  productName?: string;
  notifyDomain?: string | null;
  feeRatePercent?: string;
  minCreditUsd?: string;
  maxCreditUsd?: string;
}) {
  return apiClient.put<RechargePaymentConfigPublic>("/api/v1/recharge/config", input);
}

export function testRechargePaymentConfig(input: {
  enabled?: boolean;
  appId?: string;
  privateKey?: string;
  alipayPublicKey?: string;
  productName?: string;
  notifyDomain?: string | null;
  feeRatePercent?: string;
  minCreditUsd?: string;
  maxCreditUsd?: string;
}) {
  return apiClient.post<{ success: true; orderNo: string }>("/api/v1/recharge/config:test", input);
}

export function listRechargeOrdersAdmin(
  params: {
    status?: RechargeOrderStatus;
    needsManualHandling?: boolean;
    search?: string;
    page?: number;
    pageSize?: number;
  } = {}
) {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.needsManualHandling !== undefined) {
    query.set("needsManualHandling", String(params.needsManualHandling));
  }
  if (params.search) query.set("search", params.search);
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return apiClient.get<RechargeAdminOrderList>(`/api/v1/recharge/admin/orders${suffix}`);
}

export function getRechargeOrderAdmin(orderId: number) {
  return apiClient.get<RechargeOrderView>(`/api/v1/recharge/admin/orders/${orderId}`);
}

export function confirmRechargeOrderAdmin(orderId: number, reason: string) {
  return apiClient.post<RechargeOrderView>(`/api/v1/recharge/admin/orders/${orderId}:confirm`, {
    reason,
  });
}

export function retryRechargeOrderAdmin(orderId: number) {
  return apiClient.post<RechargeOrderView>(`/api/v1/recharge/admin/orders/${orderId}:retry`);
}

export function cancelRechargeOrderAdmin(orderId: number, reason: string) {
  return apiClient.post<RechargeOrderView>(`/api/v1/recharge/admin/orders/${orderId}:cancel`, {
    reason,
  });
}

export function closeRechargeOrderAdmin(orderId: number, reason: string) {
  return apiClient.post<RechargeOrderView>(`/api/v1/recharge/admin/orders/${orderId}:close`, {
    reason,
  });
}
