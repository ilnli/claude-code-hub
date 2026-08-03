import { describe, expect, it } from "vitest";
import { buildUpstreamBillingUrl } from "@/lib/upstream-billing/billing-url";

describe("buildUpstreamBillingUrl", () => {
  it("appends /v1/sub2api/billing for a bare origin", () => {
    expect(buildUpstreamBillingUrl("https://api.example.com")).toBe(
      "https://api.example.com/v1/sub2api/billing"
    );
  });

  it("appends /sub2api/billing when url ends with a version root", () => {
    expect(buildUpstreamBillingUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/sub2api/billing"
    );
    expect(buildUpstreamBillingUrl("https://api.example.com/v1beta")).toBe(
      "https://api.example.com/v1beta/sub2api/billing"
    );
  });

  it("truncates endpoint tails back to the version root", () => {
    expect(buildUpstreamBillingUrl("https://api.example.com/v1/messages")).toBe(
      "https://api.example.com/v1/sub2api/billing"
    );
    expect(buildUpstreamBillingUrl("https://api.example.com/openai/v1/chat/completions")).toBe(
      "https://api.example.com/openai/v1/sub2api/billing"
    );
  });

  it("tolerates trailing slashes", () => {
    expect(buildUpstreamBillingUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1/sub2api/billing"
    );
  });

  it("keeps non-version path prefixes and appends /v1", () => {
    expect(buildUpstreamBillingUrl("https://api.example.com/anthropic")).toBe(
      "https://api.example.com/anthropic/v1/sub2api/billing"
    );
  });

  it("does not treat v1-like endpoint segments as version roots", () => {
    // /v1api is not a valid version token, so it is kept and /v1 appended
    expect(buildUpstreamBillingUrl("https://api.example.com/v1api")).toBe(
      "https://api.example.com/v1api/v1/sub2api/billing"
    );
  });
});
