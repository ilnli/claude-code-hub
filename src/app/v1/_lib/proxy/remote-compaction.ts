import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "@/app/v1/_lib/proxy/endpoint-paths";

export type ExplicitCompactionVersion = "v1" | "v2";

function hasRemoteCompactionV2Trigger(requestBody: unknown): boolean {
  if (typeof requestBody !== "object" || requestBody === null) return false;

  const input = (requestBody as Record<string, unknown>).input;
  const items = Array.isArray(input) ? input : [input];
  return items.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).type === "compaction_trigger"
  );
}

/** Classify explicit compaction from the original client wire form. */
export function classifyExplicitCompactionRequest(
  pathname: string,
  requestBody: unknown
): ExplicitCompactionVersion | null {
  const normalizedPath = normalizeEndpointPath(pathname);
  if (normalizedPath === V1_ENDPOINT_PATHS.RESPONSES_COMPACT) return "v1";
  if (normalizedPath === V1_ENDPOINT_PATHS.RESPONSES && hasRemoteCompactionV2Trigger(requestBody)) {
    return "v2";
  }
  return null;
}

/**
 * 识别 Responses input 中精确的 Remote Compaction v2 trigger。
 * 单对象 input 与数组 input 使用同一 item 语义，其他类型不会被推断为 compaction。
 */
export function isRemoteCompactionV2Request(pathname: string, requestBody: unknown): boolean {
  return classifyExplicitCompactionRequest(pathname, requestBody) === "v2";
}
