import Decimal from "decimal.js-light";

export interface RechargePaymentConfigDraft {
  enabled?: boolean;
  appId?: string;
  privateKey?: string;
  alipayPublicKey?: string;
  productName?: string;
  notifyDomain?: string | null;
  feeRatePercent?: string;
  minCreditUsd?: string;
  maxCreditUsd?: string;
}

export interface ResolvedRechargePaymentConfig {
  enabled: boolean;
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  productName: string;
  notifyDomain: string | null;
  feeRatePercent: string;
  minCreditUsd: string;
  maxCreditUsd: string;
}

export function resolveRechargePaymentConfig(
  input: RechargePaymentConfigDraft,
  current: ResolvedRechargePaymentConfig | null
): ResolvedRechargePaymentConfig {
  return {
    enabled: input.enabled ?? current?.enabled ?? false,
    appId: input.appId?.trim() || current?.appId || "",
    privateKey: input.privateKey?.trim() || current?.privateKey || "",
    alipayPublicKey: input.alipayPublicKey?.trim() || current?.alipayPublicKey || "",
    productName: input.productName?.trim() || current?.productName || "",
    notifyDomain:
      input.notifyDomain === undefined
        ? (current?.notifyDomain ?? null)
        : input.notifyDomain?.trim() || null,
    feeRatePercent: input.feeRatePercent ?? current?.feeRatePercent ?? "0",
    minCreditUsd: input.minCreditUsd ?? current?.minCreditUsd ?? "1",
    maxCreditUsd: input.maxCreditUsd ?? current?.maxCreditUsd ?? "1000",
  };
}

export function validateRechargePaymentConfig(config: ResolvedRechargePaymentConfig): void {
  if (!config.appId || !config.privateKey || !config.alipayPublicKey || !config.productName) {
    throw new Error("CONFIG_REQUIRED_FIELDS_MISSING");
  }
  const fee = new Decimal(config.feeRatePercent);
  const min = new Decimal(config.minCreditUsd);
  const max = new Decimal(config.maxCreditUsd);
  if (fee.lt(0) || fee.gte(100) || fee.decimalPlaces() > 4) {
    throw new Error("CONFIG_INVALID_FEE_RATE");
  }
  if (min.lte(0) || max.lt(min) || min.decimalPlaces() > 2 || max.decimalPlaces() > 2) {
    throw new Error("CONFIG_INVALID_AMOUNT_RANGE");
  }
  if (config.notifyDomain) {
    try {
      const url = new URL(config.notifyDomain);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
    } catch {
      throw new Error("CONFIG_INVALID_NOTIFY_DOMAIN");
    }
  }
}
