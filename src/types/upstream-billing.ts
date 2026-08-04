/**
 * 上游倍率跟随（套娃场景）相关类型。
 *
 * 支持两种上游探测协议（UpstreamProbeType）：
 * - sub2api：调度器定时 GET {版本根}/sub2api/billing 读取 resolved_rate_multiplier；
 * - newapi：匿名 GET {站点}/api/pricing 读取 group_ratio 倍率表，并按 key 实际落组
 *   （GET {站点}/api/log/token 校准）取对应分组倍率；
 * 均按加价规则回写 providers.cost_multiplier。
 */

/** 加价方式：none=不加价，percent=上游倍率×(1+value)，fixed=上游倍率+value */
export type RateMarkupType = "none" | "percent" | "fixed";

export const RATE_MARKUP_TYPES: readonly RateMarkupType[] = ["none", "percent", "fixed"];

/**
 * 上游倍率探测协议类型：
 * - sub2api：GET {版本根}/sub2api/billing，消费 resolved_rate_multiplier；
 * - newapi：匿名 GET {站点}/api/pricing 取 group_ratio 倍率表，
 *   配合 GET {站点}/api/log/token（sk-）校准 key 实际落组分组。
 */
export type UpstreamProbeType = "sub2api" | "newapi";

export const UPSTREAM_PROBE_TYPES: readonly UpstreamProbeType[] = ["sub2api", "newapi"];

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
