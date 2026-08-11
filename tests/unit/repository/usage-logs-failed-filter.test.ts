import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildUsageLogConditions } from "@/repository/_shared/usage-log-filters";

function renderConditions(filters: Parameters<typeof buildUsageLogConditions>[0]): string {
  return buildUsageLogConditions(filters)
    .map((condition) => new PgDialect().sqlToQuery(condition).sql.toLowerCase())
    .join(" ");
}

describe("usage log failedOnly filter", () => {
  it("matches only final status codes outside the complete 2xx range", () => {
    const sql = renderConditions({ failedOnly: true });

    expect(sql).toContain('"message_request"."status_code" < 200');
    expect(sql).toContain('"message_request"."status_code" > 299');
    expect(sql).not.toContain('"message_request"."status_code" is null');
  });

  it("keeps the deprecated literal not-200 behavior unchanged", () => {
    const sql = renderConditions({ excludeStatusCode200: true });

    expect(sql).toContain('"message_request"."status_code" is null');
    expect(sql).toContain('"message_request"."status_code" <> 200');
  });

  it("gives an explicit status code precedence over failedOnly", () => {
    const sql = renderConditions({ statusCode: 404, failedOnly: true });

    expect(sql).toContain('"message_request"."status_code" =');
    expect(sql).not.toContain('"message_request"."status_code" < 200');
  });
});
