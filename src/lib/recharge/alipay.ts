import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  type KeyObject,
} from "node:crypto";

const ALIPAY_GATEWAY = "https://openapi.alipay.com/gateway.do";

export interface AlipayPrecreateInput {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  notifyUrl: string;
  orderNo: string;
  subject: string;
  totalAmount: string;
}

export interface AlipayPrecreateResult {
  qrCode: string;
}

export function buildAlipaySignContent(params: Record<string, string>): string {
  return Object.entries(params)
    .filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function signAlipayParameters(params: Record<string, string>, privateKey: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(buildAlipaySignContent(params), "utf8");
  signer.end();
  return signer.sign(parsePrivateKey(privateKey), "base64");
}

export function verifyAlipaySignature(
  params: Record<string, string>,
  alipayPublicKey: string
): boolean {
  const signature = params.sign;
  if (!signature) return false;

  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(buildAlipaySignContent(params), "utf8");
    verifier.end();
    return verifier.verify(parsePublicKey(alipayPublicKey), signature, "base64");
  } catch {
    return false;
  }
}

export async function createAlipayPrecreatePayment(
  input: AlipayPrecreateInput
): Promise<AlipayPrecreateResult> {
  const timestamp = formatAlipayTimestamp(new Date());
  const params: Record<string, string> = {
    app_id: input.appId,
    method: "alipay.trade.precreate",
    charset: "UTF-8",
    sign_type: "RSA2",
    timestamp,
    version: "1.0",
    notify_url: input.notifyUrl,
    biz_content: JSON.stringify({
      subject: input.subject,
      out_trade_no: input.orderNo,
      total_amount: input.totalAmount,
    }),
  };
  params.sign = signAlipayParameters(params, input.privateKey);

  const response = await fetch(ALIPAY_GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`ALIPAY_HTTP_${response.status}`);
  }

  const body = (await response.json()) as {
    alipay_trade_precreate_response?: {
      code?: string;
      msg?: string;
      sub_code?: string;
      sub_msg?: string;
      qr_code?: string;
    };
  };
  const result = body.alipay_trade_precreate_response;
  if (result?.code !== "10000" || !result.qr_code) {
    throw new Error(
      result?.sub_msg || result?.msg || result?.sub_code || "ALIPAY_PRECREATE_FAILED"
    );
  }
  return { qrCode: result.qr_code };
}

function parsePrivateKey(value: string): KeyObject {
  const trimmed = value.trim().replaceAll("\\n", "\n");
  if (trimmed.includes("-----BEGIN")) return createPrivateKey(trimmed);

  const body = trimmed.replace(/\s+/g, "");
  try {
    return createPrivateKey(toPem(body, "RSA PRIVATE KEY"));
  } catch {
    return createPrivateKey(toPem(body, "PRIVATE KEY"));
  }
}

function parsePublicKey(value: string): KeyObject {
  const trimmed = value.trim().replaceAll("\\n", "\n");
  return createPublicKey(
    trimmed.includes("-----BEGIN") ? trimmed : toPem(trimmed.replace(/\s+/g, ""), "PUBLIC KEY")
  );
}

function toPem(body: string, label: string): string {
  const lines = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function formatAlipayTimestamp(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(
    value.getHours()
  )}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
