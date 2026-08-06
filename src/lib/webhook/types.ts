/**
 * 平台无关的结构化消息类型
 */

export type MessageLevel = "info" | "warning" | "error";

export interface MessageHeader {
  title: string;
  icon?: string;
  level: MessageLevel;
}

export interface ListItem {
  icon?: string;
  primary: string;
  secondary?: string;
}

export type SectionContent =
  | { type: "text"; value: string }
  | { type: "quote"; value: string }
  | { type: "fields"; items: { label: string; value: string }[] }
  | { type: "list"; style: "ordered" | "bullet"; items: ListItem[] }
  | { type: "divider" };

export interface Section {
  title?: string;
  content: SectionContent[];
}

export interface StructuredMessage {
  header: MessageHeader;
  sections: Section[];
  footer?: Section[];
  timestamp: Date;
}

/**
 * 业务数据类型
 */

export interface CircuitBreakerAlertData {
  providerName: string;
  providerId: number;
  failureCount: number;
  retryAt?: string;
  lastError?: string;
  /** Incident source for provider, endpoint, or upstream billing probe alerts. */
  incidentSource?: "provider" | "endpoint" | "upstream_billing";
  /** Endpoint ID when incidentSource is 'endpoint' */
  endpointId?: number;
  /** Endpoint URL when incidentSource is 'endpoint' */
  endpointUrl?: string;
  /** Whether this failure caused the effective rate to fall back to its configured default. */
  fallbackApplied?: boolean;
  /** Effective fallback rate after markup, when available. */
  fallbackRate?: number;
}

export interface DailyLeaderboardEntry {
  userId: number;
  userName: string;
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
}

export interface DailyLeaderboardData {
  date: string;
  entries: DailyLeaderboardEntry[];
  totalRequests: number;
  totalCost: number;
}

export interface CostAlertData {
  targetType: "user" | "provider";
  targetName: string;
  targetId: number;
  currentCost: number;
  quotaLimit: number;
  threshold: number;
  period: string;
}

export interface CacheHitRateAlertSample {
  kind: "eligible" | "overall";
  requests: number;
  denominatorTokens: number;
  hitRateTokens: number;
}

export type CacheHitRateAlertBaselineSource = "historical" | "today" | "prev" | null;

export const CACHE_HIT_RATE_ALERT_SETTINGS_WINDOW_MODES = [
  "auto",
  "5m",
  "30m",
  "1h",
  "1.5h",
] as const;

export type CacheHitRateAlertSettingsWindowMode =
  (typeof CACHE_HIT_RATE_ALERT_SETTINGS_WINDOW_MODES)[number];

export function isCacheHitRateAlertSettingsWindowMode(
  value: unknown
): value is CacheHitRateAlertSettingsWindowMode {
  return (
    typeof value === "string" &&
    (CACHE_HIT_RATE_ALERT_SETTINGS_WINDOW_MODES as readonly string[]).includes(value)
  );
}

export interface CacheHitRateAlertAnomaly {
  providerId: number;
  providerName?: string;
  providerType?: string;
  model: string;

  baselineSource: CacheHitRateAlertBaselineSource;
  current: CacheHitRateAlertSample;
  baseline: CacheHitRateAlertSample | null;

  deltaAbs: number | null;
  deltaRel: number | null;
  dropAbs: number | null;

  reasonCodes: string[];
}

export interface CacheHitRateAlertWindow {
  mode: CacheHitRateAlertSettingsWindowMode;
  startTime: string;
  endTime: string;
  durationMinutes: number;
}

export interface CacheHitRateAlertSettingsSnapshot {
  windowMode: CacheHitRateAlertSettingsWindowMode;
  checkIntervalMinutes: number;
  historicalLookbackDays: number;
  minEligibleRequests: number;
  minEligibleTokens: number;
  absMin: number;
  dropRel: number;
  dropAbs: number;
  cooldownMinutes: number;
  topN: number;
}

export interface CacheHitRateAlertData {
  window: CacheHitRateAlertWindow;
  anomalies: CacheHitRateAlertAnomaly[];
  suppressedCount: number;
  settings: CacheHitRateAlertSettingsSnapshot;
  generatedAt: string;
}

export interface ModelMismatchPair {
  requestedModel: string;
  actualResponseModel: string;
}

export interface ModelMismatchAlertData {
  providerId: number;
  providerName: string;
  occurrenceCount: number;
  mismatches: ModelMismatchPair[];
  windowStart: string;
  windowEnd: string;
  cooldownMinutes: number;
  generatedAt: string;
}

export interface ProviderWeightAdjustmentAlertData {
  event: "fault" | "recovery";
  ruleId: number;
  ruleName: string;
  runId?: number;
  faultKind?: string;
  message?: string;
  generatedAt: string;
}

/**
 * Webhook 相关类型
 */

export type ProviderType = "wechat" | "feishu" | "dingtalk" | "telegram" | "custom";

export type WebhookNotificationType =
  | "circuit_breaker"
  | "daily_leaderboard"
  | "cost_alert"
  | "cache_hit_rate_alert"
  | "model_mismatch_alert"
  | "weight_adjustment_alert";

export interface WebhookTargetConfig {
  id?: number;
  name?: string;
  providerType: ProviderType;

  webhookUrl?: string | null;

  telegramBotToken?: string | null;
  telegramChatId?: string | null;

  dingtalkSecret?: string | null;

  customTemplate?: Record<string, unknown> | null;
  customHeaders?: Record<string, string> | null;

  proxyUrl?: string | null;
  proxyFallbackToDirect?: boolean;
}

export interface WebhookSendOptions {
  notificationType?: WebhookNotificationType;
  data?: unknown;
  templateOverride?: Record<string, unknown> | null;
  /** IANA timezone identifier for date/time formatting */
  timezone?: string;
}

export interface WebhookPayload {
  body: string;
  headers?: Record<string, string>;
}

export interface WebhookResult {
  success: boolean;
  error?: string;
}
