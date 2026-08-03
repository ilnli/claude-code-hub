import type { CircuitBreakerAlertData, StructuredMessage } from "../types";
import { formatDateTime } from "../utils/date";

export function buildCircuitBreakerMessage(
  data: CircuitBreakerAlertData,
  timezone?: string
): StructuredMessage {
  const isEndpoint = data.incidentSource === "endpoint";
  const isUpstreamBilling = data.incidentSource === "upstream_billing";

  const fields = [{ label: "失败次数", value: `${data.failureCount} 次` }];

  if (!isUpstreamBilling && data.retryAt) {
    fields.push({ label: "预计恢复", value: formatDateTime(data.retryAt, timezone || "UTC") });
  }

  if (data.lastError) {
    fields.push({ label: "最后错误", value: data.lastError });
  }

  if (isUpstreamBilling) {
    fields.push({
      label: "倍率处理",
      value: data.fallbackApplied
        ? `已回退到默认倍率${data.fallbackRate == null ? "" : ` ${data.fallbackRate}`}`
        : "保留上一次生效倍率",
    });
  }

  // Add endpoint-specific fields
  if (isEndpoint) {
    if (data.endpointId !== undefined) {
      fields.push({ label: "端点ID", value: String(data.endpointId) });
    }
    if (data.endpointUrl) {
      fields.push({ label: "端点地址", value: data.endpointUrl });
    }
  }

  const title = isUpstreamBilling
    ? "上游倍率探测失败"
    : isEndpoint
      ? "端点熔断告警"
      : "供应商熔断告警";
  const description = isUpstreamBilling
    ? `供应商 ${data.providerName} (ID: ${data.providerId}) 的上游倍率探测失败`
    : isEndpoint
      ? `供应商 ${data.providerName} 的端点 (ID: ${data.endpointId ?? "N/A"}) 已触发熔断保护`
      : `供应商 ${data.providerName} (ID: ${data.providerId}) 已触发熔断保护`;

  return {
    header: {
      title,
      icon: "🔌",
      level: "error",
    },
    sections: [
      {
        content: [
          {
            type: "quote",
            value: description,
          },
        ],
      },
      {
        title: "详细信息",
        content: [{ type: "fields", items: fields }],
      },
    ],
    footer: [
      {
        content: [
          {
            type: "text",
            value: isUpstreamBilling
              ? "连续失败达到 3 次后自动回退默认倍率；探测成功后失败计数清零"
              : "熔断器将在预计时间后自动恢复",
          },
        ],
      },
    ],
    timestamp: new Date(),
  };
}
