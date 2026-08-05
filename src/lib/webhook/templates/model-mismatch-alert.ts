import type { ModelMismatchAlertData, StructuredMessage } from "../types";
import { formatDateTime } from "../utils/date";

export function buildModelMismatchAlertMessage(
  data: ModelMismatchAlertData,
  timezone?: string
): StructuredMessage {
  const tz = timezone || "UTC";
  const requestedModels = Array.from(new Set(data.mismatches.map((item) => item.requestedModel)));
  const actualResponseModels = Array.from(
    new Set(data.mismatches.map((item) => item.actualResponseModel))
  );

  return {
    header: {
      title: "供应商模型掺假告警",
      icon: "[MODEL]",
      level: "warning",
    },
    sections: [
      {
        content: [
          {
            type: "quote",
            value: `供应商 ${data.providerName} (ID: ${data.providerId}) 返回了与请求不一致的模型`,
          },
        ],
      },
      {
        title: "统计信息",
        content: [
          {
            type: "fields",
            items: [
              { label: "发生次数", value: `${data.occurrenceCount} 次` },
              { label: "统计开始", value: formatDateTime(data.windowStart, tz) },
              { label: "统计结束", value: formatDateTime(data.windowEnd, tz) },
              { label: "通知冷却", value: `${data.cooldownMinutes} 分钟` },
            ],
          },
        ],
      },
      {
        title: "模型信息",
        content: [
          {
            type: "fields",
            items: [
              { label: "请求模型", value: requestedModels.join("\n") },
              { label: "实际响应模型", value: actualResponseModels.join("\n") },
            ],
          },
          {
            type: "list",
            style: "bullet",
            items: data.mismatches.map((item) => ({
              primary: item.requestedModel,
              secondary: `实际响应: ${item.actualResponseModel}`,
            })),
          },
        ],
      },
    ],
    timestamp: new Date(data.generatedAt),
  };
}
