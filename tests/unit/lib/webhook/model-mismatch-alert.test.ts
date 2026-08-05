import { describe, expect, test } from "vitest";
import { buildModelMismatchAlertMessage } from "@/lib/webhook";
import { buildTemplateVariables } from "@/lib/webhook/templates/placeholders";

const payload = {
  providerId: 7,
  providerName: "Provider A",
  occurrenceCount: 5,
  mismatches: [
    { requestedModel: "requested-a", actualResponseModel: "actual-a" },
    { requestedModel: "requested-b", actualResponseModel: "actual-b" },
  ],
  windowStart: "2026-08-05T10:00:00.000Z",
  windowEnd: "2026-08-05T10:10:01.000Z",
  cooldownMinutes: 10,
  generatedAt: "2026-08-05T10:10:01.000Z",
};

describe("model mismatch alert webhook", () => {
  test("message shows provider, count, requested models, and all actual models", () => {
    const message = buildModelMismatchAlertMessage(payload, "UTC");
    const rendered = JSON.stringify(message);

    expect(rendered).toContain("Provider A");
    expect(rendered).toContain("5 次");
    expect(rendered).toContain("requested-a");
    expect(rendered).toContain("requested-b");
    expect(rendered).toContain("actual-a");
    expect(rendered).toContain("actual-b");
  });

  test("custom template variables contain the aggregate and model lists", () => {
    const message = buildModelMismatchAlertMessage(payload, "UTC");
    const variables = buildTemplateVariables({
      message,
      notificationType: "model_mismatch_alert",
      data: payload,
      timezone: "UTC",
    });

    expect(variables).toMatchObject({
      "{{provider_name}}": "Provider A",
      "{{provider_id}}": "7",
      "{{occurrence_count}}": "5",
      "{{window_start}}": payload.windowStart,
      "{{window_end}}": payload.windowEnd,
      "{{cooldown_minutes}}": "10",
      "{{requested_models_json}}": JSON.stringify(["requested-a", "requested-b"]),
      "{{actual_response_models_json}}": JSON.stringify(["actual-a", "actual-b"]),
      "{{mismatches_json}}": JSON.stringify(payload.mismatches),
    });
  });
});
