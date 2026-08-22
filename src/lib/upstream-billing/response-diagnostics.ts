const MAX_UPSTREAM_ERROR_LENGTH = 500;

const CLOUDFLARE_BLOCK_PATTERNS = [
  /cloudflare ray id/i,
  /sorry, you have been blocked/i,
  /attention required[!|]?\s*cloudflare/i,
  /error\s*(?:code)?\s*[:#]?\s*1020/i,
  /\/cdn-cgi\/challenge-platform/i,
  /\/cdn-cgi\/access/i,
  /cf-chl-/i,
  /cf-error-details/i,
  /just a moment/i,
];

export type UpstreamEdgeProvider = "cloudflare";

export interface UpstreamResponseDiagnostics {
  body: unknown;
  jsonParsed: boolean;
  error?: string;
  edgeBlocked: boolean;
  edgeProvider?: UpstreamEdgeProvider;
  requestId?: string;
}

function getResponseHeader(response: Response, name: string): string | undefined {
  try {
    return response.headers?.get(name)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function sanitizeUpstreamText(
  value: string,
  sensitiveValues: Array<string | null | undefined>
): string | undefined {
  let sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) return undefined;

  for (const sensitiveValue of sensitiveValues) {
    const secret = sensitiveValue?.trim();
    if (secret) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }

  return sanitized.slice(0, MAX_UPSTREAM_ERROR_LENGTH);
}

function extractErrorFromJson(
  body: unknown,
  sensitiveValues: Array<string | null | undefined>
): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;

  const record = body as Record<string, unknown>;
  const nestedError =
    record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>).message
      : record.error;
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof nestedError === "string"
        ? nestedError
        : undefined;
  const code =
    typeof record.code === "string" || typeof record.code === "number"
      ? String(record.code)
      : undefined;
  const detail = code && message ? `${code}: ${message}` : code || message;

  return detail ? sanitizeUpstreamText(detail, sensitiveValues) : undefined;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    try {
      await response.body?.cancel();
    } catch {
      // Releasing the body is best-effort only.
    }
    return "";
  }
}

export async function inspectUpstreamResponse(
  response: Response,
  sensitiveValues: Array<string | null | undefined> = []
): Promise<UpstreamResponseDiagnostics> {
  const server = getResponseHeader(response, "server");
  const contentType = getResponseHeader(response, "content-type");
  const cfRay = getResponseHeader(response, "cf-ray");
  const cfMitigated = getResponseHeader(response, "cf-mitigated");
  const bodyText = await readResponseText(response);

  let body: unknown;
  let jsonParsed = false;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
      jsonParsed = true;
    } catch {
      body = bodyText;
    }
  }

  // Cloudflare challenge/block bodies are non-JSON pages. Do not let ordinary API messages such
  // as "Just a moment" turn an otherwise valid JSON response into an edge-block failure.
  const cloudflareBodyMarker =
    !jsonParsed && CLOUDFLARE_BLOCK_PATTERNS.some((pattern) => pattern.test(bodyText));
  const cloudflareHeaders =
    server?.toLowerCase().includes("cloudflare") === true ||
    Boolean(cfRay) ||
    cfMitigated?.toLowerCase() === "challenge";
  const htmlResponse =
    contentType?.toLowerCase().includes("text/html") === true ||
    /^\s*(?:<!doctype\s+html|<html\b)/i.test(bodyText);
  const edgeProvider: UpstreamEdgeProvider | undefined =
    cloudflareHeaders || cloudflareBodyMarker ? "cloudflare" : undefined;
  const cloudflareEdgeErrorStatus =
    response.status === 403 ||
    response.status === 429 ||
    response.status === 503 ||
    (response.status >= 520 && response.status <= 530);
  const edgeBlocked =
    edgeProvider === "cloudflare" &&
    (cloudflareBodyMarker ||
      cfMitigated?.toLowerCase() === "challenge" ||
      (htmlResponse && cloudflareEdgeErrorStatus));

  const bodyError = jsonParsed
    ? extractErrorFromJson(body, sensitiveValues)
    : sanitizeUpstreamText(bodyText, sensitiveValues);

  if (!edgeBlocked) {
    return {
      body,
      jsonParsed,
      ...(bodyError ? { error: bodyError } : {}),
      edgeBlocked: false,
      ...(edgeProvider ? { edgeProvider } : {}),
      ...(cfRay ? { requestId: cfRay } : {}),
    };
  }

  const metadata = [`HTTP ${response.status}`, cfRay ? `CF-Ray ${cfRay}` : null].filter(
    (value): value is string => value !== null
  );
  const summary = `Cloudflare edge blocked or challenged the probe (${metadata.join(", ")})`;

  return {
    body,
    jsonParsed,
    error: bodyError ? `${summary}: ${bodyError}` : summary,
    edgeBlocked: true,
    edgeProvider: "cloudflare",
    ...(cfRay ? { requestId: cfRay } : {}),
  };
}
