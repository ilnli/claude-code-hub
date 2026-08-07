export function buildAlipayNotifyUrl(
  configuredDomain: string | null,
  appUrl: string | undefined,
  requestOrigin: string
): string {
  const base = configuredDomain?.trim() || appUrl?.trim() || requestOrigin;
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("ALIPAY_NOTIFY_URL_INVALID");
  }
  return `${url.origin}/api/v1/recharge/alipay/notify`;
}
