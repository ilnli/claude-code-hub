/**
 * 根据 provider.url 推导上游 sub2api 探测端点 URL。
 *
 * sub2api 的计费探测端点固定挂在 API 版本根下：GET {版本根}/sub2api/billing
 * （官方部署为 /v1/sub2api/billing）。
 *
 * provider.url 在系统中允许三种形态：
 * 1. 纯 origin：https://api.example.com        -> https://api.example.com/v1/sub2api/billing
 * 2. 版本根：  https://api.example.com/v1      -> https://api.example.com/v1/sub2api/billing
 * 3. 完整端点：https://api.example.com/v1/messages -> https://api.example.com/v1/sub2api/billing
 *    （含中间前缀也支持：/openai/v1/chat/completions -> /openai/v1/sub2api/billing）
 */

// 与 src/app/v1/_lib/url.ts 中 isVersionRootPath 相同的版本 token 判定
const VERSION_TOKEN_REGEX =
  /^(v\d+(?:(?:alpha|beta|preview|internal|rc|ga|stable|dev|canary)\d*)?)$/i;

export function buildUpstreamBillingUrl(providerUrl: string): string {
  const parsed = new URL(providerUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);

  // 找到第一个版本 token 段；其后的一切（endpoint 尾段）都丢弃
  const versionIndex = segments.findIndex((segment) => VERSION_TOKEN_REGEX.test(segment));

  const baseSegments =
    versionIndex >= 0 ? segments.slice(0, versionIndex + 1) : [...segments, "v1"];

  const basePath = `/${[...baseSegments, "sub2api", "billing"].join("/")}`;
  return `${parsed.origin}${basePath}`;
}
