import type { ProviderWeightAdjustmentAlertData, StructuredMessage } from "../types";

export function buildProviderWeightAdjustmentAlertMessage(
  data: ProviderWeightAdjustmentAlertData
): StructuredMessage {
  const recovery = data.event === "recovery";
  return {
    header: {
      title: recovery ? "Provider weight adjustment recovered" : "Provider weight adjustment fault",
      icon: "[WEIGHT]",
      level: recovery ? "info" : "error",
    },
    sections: [
      {
        content: [
          {
            type: "fields",
            items: [
              { label: "Rule", value: `${data.ruleName} (ID: ${data.ruleId})` },
              { label: "Event", value: data.event },
              ...(data.runId === undefined ? [] : [{ label: "Run ID", value: String(data.runId) }]),
              ...(data.faultKind ? [{ label: "Fault", value: data.faultKind }] : []),
              ...(data.message ? [{ label: "Detail", value: data.message }] : []),
            ],
          },
        ],
      },
    ],
    timestamp: new Date(data.generatedAt),
  };
}
