/**
 * 根据 provider.url 推导 new-api 站点根地址。
 *
 * new-api 的管理面端点挂在站点根下（/api/pricing、/api/log/token），与 sub2api
 * 把探测端点挂在版本根下不同：推导时必须剥掉 /v1 等版本段。
 *
 * provider.url 允许的形态：
 * 1. 纯 origin：https://api.example.com          -> https://api.example.com
 * 2. 版本根：  https://api.example.com/v1        -> https://api.example.com
 * 3. 完整端点：https://api.example.com/v1/messages -> https://api.example.com
 * 4. 前缀部署：https://api.example.com/newapi/v1   -> https://api.example.com/newapi
 *             https://api.example.com/newapi     -> https://api.example.com/newapi
 * （规则：截到第一个版本 token 段之前；无版本段则保留完整路径）
 */

// 与 billing-url.ts 相同的版本 token 判定
const VERSION_TOKEN_REGEX =
  /^(v\d+(?:(?:alpha|beta|preview|internal|rc|ga|stable|dev|canary)\d*)?)$/i;

export function buildNewapiBaseUrl(providerUrl: string): string {
  const parsed = new URL(providerUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);

  const versionIndex = segments.findIndex((segment) => VERSION_TOKEN_REGEX.test(segment));
  const baseSegments = versionIndex >= 0 ? segments.slice(0, versionIndex) : segments;

  const basePath = baseSegments.length > 0 ? `/${baseSegments.join("/")}` : "";
  return `${parsed.origin}${basePath}`;
}

export function buildNewapiPricingUrl(providerUrl: string): string {
  return `${buildNewapiBaseUrl(providerUrl)}/api/pricing`;
}

export function buildNewapiTokenLogsUrl(providerUrl: string): string {
  return `${buildNewapiBaseUrl(providerUrl)}/api/log/token`;
}
