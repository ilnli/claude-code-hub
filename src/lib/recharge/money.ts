import Decimal from "decimal.js-light";

Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });

export function normalizeCreditAmount(value: string | number): string {
  const amount = new Decimal(value);
  if (amount.lte(0) || amount.decimalPlaces() > 2) {
    throw new Error("INVALID_CREDIT_AMOUNT");
  }
  return amount.toFixed(2);
}

export function calculateAlipayAmount(
  creditUsd: string | number,
  feeRatePercent: string | number
): string {
  const credit = new Decimal(normalizeCreditAmount(creditUsd));
  const feePercent = new Decimal(feeRatePercent);
  if (feePercent.lt(0) || feePercent.gte(100)) {
    throw new Error("INVALID_FEE_RATE");
  }

  const multiplier = new Decimal(1).plus(feePercent.div(100));
  return credit.mul(multiplier).toDecimalPlaces(2, Decimal.ROUND_CEIL).toFixed(2);
}

export function isAmountWithinRange(amount: string, minimum: string, maximum: string): boolean {
  const value = new Decimal(amount);
  return value.gte(new Decimal(minimum)) && value.lte(new Decimal(maximum));
}
