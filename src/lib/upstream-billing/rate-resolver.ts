import type { RateMarkupType } from "@/types/upstream-billing";
import { UPSTREAM_RATE_MAX, UPSTREAM_RATE_MIN_EXCLUSIVE } from "@/types/upstream-billing";

/**
 * 倍率保留 4 位小数（与 providers.cost_multiplier numeric(10,4) 精度一致）。
 */
export function roundRate4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * 校验上游探测到的倍率是否在合法值域 (0, 100]。
 * 与 sub2api 的 rate_multiplier 语义一致；越界值一律拒绝（fail-closed）。
 */
export function isValidUpstreamRate(value: number): boolean {
  return (
    Number.isFinite(value) && value > UPSTREAM_RATE_MIN_EXCLUSIVE && value <= UPSTREAM_RATE_MAX
  );
}

/**
 * 在基础倍率上应用加价规则：
 * - none：不加价
 * - percent：base × (1 + value)，如 value=0.1 即 +10%
 * - fixed：base + value，如 value=0.01
 *
 * 结果保留 4 位小数并收敛到 [0, 100]（上游倍率本身在入库前已按 (0,100] 校验，
 * 且加价数值非负，因此正常路径不会触到下界）。
 */
export function applyMarkup(base: number, markupType: RateMarkupType, markupValue: number): number {
  let result: number;
  switch (markupType) {
    case "percent":
      result = base * (1 + markupValue);
      break;
    case "fixed":
      result = base + markupValue;
      break;
    default:
      result = base;
      break;
  }

  const rounded = roundRate4(result);
  if (!Number.isFinite(rounded) || rounded < 0) {
    return 0;
  }
  return Math.min(rounded, UPSTREAM_RATE_MAX);
}
