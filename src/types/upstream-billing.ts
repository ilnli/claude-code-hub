/**
 * 上游倍率跟随（套娃场景）相关类型。
 *
 * 上游为支持 GET /v1/sub2api/billing 探测协议的中转站（如 sub2api）时，
 * 调度器定时读取其 resolved_rate_multiplier 并按加价规则回写 providers.cost_multiplier。
 */

/** 加价方式：none=不加价，percent=上游倍率×(1+value)，fixed=上游倍率+value */
export type RateMarkupType = "none" | "percent" | "fixed";

export const RATE_MARKUP_TYPES: readonly RateMarkupType[] = ["none", "percent", "fixed"];

/** 上游倍率允许的值域：(0, 100]，与 sub2api 的 rate_multiplier 语义一致 */
export const UPSTREAM_RATE_MIN_EXCLUSIVE = 0;
export const UPSTREAM_RATE_MAX = 100;

/** GET /v1/sub2api/billing 响应中我们消费的部分（其余字段宽容忽略） */
export interface UpstreamBillingResponse {
  resolved_rate_multiplier: number;
  effective_rate_multiplier?: number;
  group_rate_multiplier?: number;
  user_rate_multiplier?: number;
  peak_rate_enabled?: boolean;
  applied_peak_multiplier?: number;
  timezone?: string;
  observed_at?: string;
}
