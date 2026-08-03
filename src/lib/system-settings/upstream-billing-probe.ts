import "server-only";

import { getCachedSystemSettings } from "@/lib/config/system-settings-cache";

/**
 * 上游倍率探测的运行时设置快照（system_settings 表）。
 *
 * - enabled：全局开关，默认关闭（关闭时调度器空转，对系统零影响）
 * - intervalMinutes：每个 provider 的探测间隔，默认 30 分钟
 *
 * 读取约定与 proxy-runtime.ts 一致：异步场景用 getUpstreamBillingProbeSettings()
 * （经 system-settings-cache，自带 1 分钟 TTL），同步快照用 getCachedUpstreamBillingProbeSettings()。
 */
export interface UpstreamBillingProbeSettings {
  enabled: boolean;
  intervalMinutes: number;
}

const DEFAULT_SETTINGS: UpstreamBillingProbeSettings = {
  enabled: false,
  intervalMinutes: 30,
};

// 最近一次成功读取的快照；DB 异常时兜底，保证调度器行为可预期。
let lastKnown: UpstreamBillingProbeSettings | null = null;

export async function getUpstreamBillingProbeSettings(): Promise<UpstreamBillingProbeSettings> {
  try {
    const settings = await getCachedSystemSettings();
    lastKnown = {
      enabled: settings.upstreamBillingProbeEnabled,
      intervalMinutes: settings.upstreamBillingProbeIntervalMinutes,
    };
    return lastKnown;
  } catch {
    // getCachedSystemSettings 自身已 fail-safe；此处兜底其意外异常
    return lastKnown ?? DEFAULT_SETTINGS;
  }
}

/**
 * 同步返回最近快照；尚无快照时返回 null。
 */
export function getCachedUpstreamBillingProbeSettings(): UpstreamBillingProbeSettings | null {
  return lastKnown;
}
