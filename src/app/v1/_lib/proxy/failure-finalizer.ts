import { getLocale } from "next-intl/server";
import { logger } from "@/lib/logger";
import { getErrorMessageServer } from "@/lib/utils/error-messages";
import { createMessageRequest, updateMessageRequestPublicErrorDurably } from "@/repository/message";
import { PUBLIC_ERROR_I18N_KEYS, type PublicErrorCode } from "@/types/public-error";
import type { ProxySession } from "./session";
import { ProxySessionGuard } from "./session-guard";

const PERSIST_TIMEOUT_MS = 3_000;

function classifyStatus(status: number): PublicErrorCode {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 402) return "quota_exceeded";
  if (status === 429) return "rate_limited";
  if (status === 499) return "request_cancelled";
  if (status >= 500) return "service_unavailable";
  return "invalid_request";
}

async function resolvePublicMessage(code: PublicErrorCode): Promise<string> {
  try {
    return await getErrorMessageServer(await getLocale(), PUBLIC_ERROR_I18N_KEYS[code]);
  } catch {
    return "An error occurred";
  }
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("failure persistence timed out")),
          PERSIST_TIMEOUT_MS
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function finalizeFailedRequest(
  session: ProxySession,
  response: Response,
  cause?: unknown
): Promise<void> {
  if (response.status >= 200 && response.status <= 299) return;

  const auth = session.authState;
  if (!auth?.user || !auth.key || !auth.apiKey) return;

  try {
    await ProxySessionGuard.ensureCorrelation(session);
    const failure = session.getTerminalFailureMetadata();
    const code = failure?.code ?? classifyStatus(response.status);
    const publicMessage = await resolvePublicMessage(code);
    const causeMessage = cause instanceof Error ? cause.message : cause ? String(cause) : null;

    if (session.messageContext) {
      await updateMessageRequestPublicErrorDurably(session.messageContext.id, {
        publicErrorCode: code,
        publicErrorMessage: publicMessage,
      });
      return;
    }

    const identity = session.getSessionIdentityMetadata();
    const record = await withTimeout(
      createMessageRequest({
        request_uuid: session.requestUuid,
        provider_id: session.provider?.id ?? null,
        user_id: auth.user.id,
        key: auth.apiKey,
        model: session.request.model ?? undefined,
        original_model: session.getOriginalModel() ?? session.request.model ?? undefined,
        duration_ms: Math.max(0, Date.now() - session.startTime),
        cost_usd: 0,
        cost_multiplier: session.provider?.costMultiplier,
        group_cost_multiplier: session.getGroupCostMultiplier(),
        session_id: session.sessionId ?? undefined,
        session_identity: identity.identity || session.sessionId || undefined,
        session_identity_kind: identity.kind,
        affinity_scope_tag: identity.scopeTag,
        affinity_fingerprint: identity.fingerprint,
        affinity_fingerprint_chain: identity.fingerprints,
        request_sequence: session.getRequestSequence(),
        provider_chain: session.getProviderChain(),
        routing_trace: session.getRoutingTrace(),
        status_code: response.status,
        error_message:
          failure?.adminMessage ??
          causeMessage ??
          `Request failed with HTTP status ${response.status}`,
        public_error_code: code,
        public_error_message: publicMessage,
        blocked_by: failure?.blockedBy,
        blocked_reason: failure?.blockedReason,
        user_agent: session.userAgent ?? undefined,
        client_ip: session.clientIp ?? undefined,
        endpoint: session.getManagedEndpoint(),
        messages_count: session.getMessagesLength(),
        special_settings: session.getSpecialSettings(),
      })
    );

    session.setMessageContext({
      id: record.id,
      createdAt: record.createdAt,
      user: auth.user,
      key: auth.key,
      apiKey: auth.apiKey,
    });
  } catch (error) {
    logger.error("[FailureFinalizer] Failed to persist terminal request failure", {
      requestUuid: session.requestUuid,
      sessionId: session.sessionId,
      statusCode: response.status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
