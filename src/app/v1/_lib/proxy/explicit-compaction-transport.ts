import { ProxyError } from "./errors";
import type { ExplicitCompactionVersion } from "./remote-compaction";

const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";

export type ExplicitCompactionUpstreamMode = "standard" | "sub2api_native_v2" | "sub2api_v1_bridge";

export interface PreparedExplicitCompactionTransport {
  body: BodyInit | undefined;
  headers: Headers;
  isStreaming: boolean;
  mode: ExplicitCompactionUpstreamMode;
  url: string;
}

function betaFeatures(headers: Headers): string[] {
  return (headers.get("x-codex-beta-features") ?? "")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
}

function setBetaFeatures(headers: Headers, features: string[]): void {
  const deduplicated = Array.from(new Set(features));
  if (deduplicated.length === 0) {
    headers.delete("x-codex-beta-features");
    return;
  }
  headers.set("x-codex-beta-features", deduplicated.join(", "));
}

function responsesUrlFromCompact(url: string): string {
  const parsed = new URL(url);
  const trimmed = parsed.pathname.replace(/\/+$/, "");
  if (!trimmed.endsWith("/responses/compact")) {
    throw new ProxyError("Invalid sub2api compaction bridge target", 500);
  }
  parsed.pathname = `${trimmed.slice(0, -"/compact".length)}`;
  return parsed.toString();
}

function buildSub2ApiV1BridgeBody(message: Record<string, unknown>): string {
  const cloned = structuredClone(message);
  const originalInput = cloned.input;
  const input = Array.isArray(originalInput)
    ? [...originalInput]
    : originalInput === undefined
      ? []
      : [originalInput];
  if (
    !input.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).type === "compaction_trigger"
    )
  ) {
    input.push({ type: "compaction_trigger" });
  }
  cloned.input = input;
  cloned.stream = true;
  return JSON.stringify(cloned);
}

/**
 * Build the attempt-local wire form without mutating the original client request.
 */
export function prepareExplicitCompactionTransport(input: {
  body: BodyInit | undefined;
  headers: Headers;
  isStreaming: boolean;
  isSub2Api: boolean;
  message: Record<string, unknown>;
  url: string;
  version: ExplicitCompactionVersion;
}): PreparedExplicitCompactionTransport {
  const headers = new Headers(input.headers);

  if (!input.isSub2Api) {
    return {
      body: input.body,
      headers,
      isStreaming: input.isStreaming,
      mode: "standard",
      url: input.url,
    };
  }

  if (input.version === "v2") {
    if (input.message.stream !== true) {
      throw new ProxyError("remote_compaction_v2_requires_stream", 400);
    }
    const features = betaFeatures(headers);
    if (!features.includes(REMOTE_COMPACTION_V2_FEATURE)) {
      features.push(REMOTE_COMPACTION_V2_FEATURE);
    }
    setBetaFeatures(headers, features);
    headers.set("accept", "text/event-stream");
    return {
      body: input.body,
      headers,
      isStreaming: true,
      mode: "sub2api_native_v2",
      url: input.url,
    };
  }

  const features = betaFeatures(headers).filter(
    (feature) => feature !== REMOTE_COMPACTION_V2_FEATURE
  );
  setBetaFeatures(headers, features);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const body = buildSub2ApiV1BridgeBody(input.message);
  return {
    body,
    headers,
    isStreaming: true,
    mode: "sub2api_v1_bridge",
    url: responsesUrlFromCompact(input.url),
  };
}
