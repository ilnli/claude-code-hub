import { redactUrlCredentials } from "@/lib/api/v1/_shared/redaction";
import { sanitizeErrorTextForDetail } from "@/lib/utils/upstream-error-detection";

const OMITTED_FIELDS = new Set([
  "headers",
  "body",
  "requestbody",
  "responsebody",
  "upstreambody",
  "upstreamparsed",
  "rawbody",
  "messages",
  "contents",
  "instructions",
  "prompt",
]);
const SECRET_FIELDS =
  /^(?:authorization|proxyauthorization|cookie|setcookie|key|apikey|xapikey|password|secret|token|accesstoken|refreshtoken)$/i;

function sanitizeText(text: string): string {
  const withoutUrlSecrets = text.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    try {
      const url = new URL(redactUrlCredentials(value) ?? value);
      for (const name of [...url.searchParams.keys()]) {
        if (/key|token|secret|password|signature|credential|auth/i.test(name)) {
          url.searchParams.set(name, "REDACTED");
        }
      }
      return url.toString();
    } catch {
      return value;
    }
  });
  return sanitizeErrorTextForDetail(withoutUrlSecrets);
}

/** Export the already-authorized detail snapshot; never fetch prompts or response bodies. */
export function buildRequestDiagnosticExport(details: Record<string, unknown>): {
  filename: string;
  content: string;
} {
  const id = typeof details.requestId === "number" ? details.requestId : "unknown";
  return {
    filename: `cch-request-${id}.json`,
    content: JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
        request: details,
      },
      (key, value: unknown) => {
        const normalized = key.replace(/[-_]/g, "").toLowerCase();
        if (OMITTED_FIELDS.has(normalized)) return value == null ? null : "[OMITTED]";
        if (SECRET_FIELDS.test(normalized)) return value == null ? null : "[REDACTED]";
        if (typeof value === "string") return sanitizeText(value);
        return value === undefined ? null : value;
      },
      2
    ),
  };
}
