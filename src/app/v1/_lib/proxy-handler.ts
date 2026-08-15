import type { Context } from "hono";
import { isRawPassthroughEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { findSafeDatabaseError } from "@/drizzle/admitted-client";
import { getCachedSystemSettings } from "@/lib/config";
import { logger } from "@/lib/logger";
import { ProxyStatusTracker } from "@/lib/proxy-status-tracker";
import { SessionManager } from "@/lib/session-manager";
import { SessionTracker } from "@/lib/session-tracker";
import { ERROR_CODES, getErrorMessageServer } from "@/lib/utils/error-messages";
import { isReservedInternalEndpointPath } from "./proxy/endpoint-paths";
import { ProxyErrorHandler } from "./proxy/error-handler";
import {
  attachSessionIdToErrorMessage,
  attachSessionIdToErrorResponse,
} from "./proxy/error-session-id";
import { ProxyError } from "./proxy/errors";
import { createExplicitCompactionV2HeartbeatResponse } from "./proxy/explicit-compaction-heartbeat";
import { finalizeFailedRequest } from "./proxy/failure-finalizer";
import { tryFakeStreamingPath } from "./proxy/fake-streaming/proxy-integration";
import { detectClientFormat, detectFormatByEndpoint } from "./proxy/format-mapper";
import { ProxyForwarder } from "./proxy/forwarder";
import { GuardPipelineBuilder } from "./proxy/guard-pipeline";
import { ProxyResponseHandler } from "./proxy/response-handler";
import { normalizeResponseInput } from "./proxy/response-input-rectifier";
import { ProxyResponses } from "./proxy/responses";
import { ProxySession } from "./proxy/session";

export async function handleProxyRequest(c: Context): Promise<Response> {
  let session: ProxySession | null = null;
  let cachedSystemSettings: Awaited<ReturnType<typeof getCachedSystemSettings>> | null = null;
  let acquiredConcurrencySessionId: string | null = null;
  let acquiredObservedSessionIdentity: string | null = null;

  const trackObservedSession = async (resolvedSession: ProxySession): Promise<string | null> => {
    if (!resolvedSession.shouldTrackSessionObservability()) return null;
    const identity = resolvedSession.getSessionIdentityMetadata();
    if (!identity.identity) return null;

    void SessionTracker.trackObservedSession(identity.identity).catch((error) => {
      logger.warn("[ProxyHandler] Failed to track observed session", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const authState = resolvedSession.authState;
    if (authState?.user && authState.key) {
      void SessionManager.storeSessionInfo(identity.identity, {
        userName: authState.user.name,
        userId: authState.user.id,
        keyId: authState.key.id,
        keyName: authState.key.name,
        model: resolvedSession.request.model,
        apiType: resolvedSession.originalFormat === "openai" ? "codex" : "chat",
      }).catch((error) => {
        logger.warn("[ProxyHandler] Failed to store observed session info", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return identity.identity;
  };
  try {
    const requestUrl = typeof c.req?.url === "string" ? new URL(c.req.url) : null;
    if (requestUrl && isReservedInternalEndpointPath(requestUrl.pathname)) {
      return ProxyResponses.buildError(404, "Resource not found", "not_found_error");
    }

    session = await ProxySession.fromContext(c);
    try {
      cachedSystemSettings = await getCachedSystemSettings();
      session.setHighConcurrencyModeEnabled(
        cachedSystemSettings.enableHighConcurrencyMode ?? false
      );
      session.setRawCrossProviderFallbackEnabled(
        cachedSystemSettings.allowNonConversationEndpointProviderFallback ?? true
      );
    } catch (settingsError) {
      const databaseError = findSafeDatabaseError(settingsError);
      logger.warn(
        "[ProxyHandler] Failed to load proxy system settings, fallback highConcurrency=false and rawCrossProviderFallback=false",
        {
          error:
            databaseError?.message ??
            (settingsError instanceof Error ? settingsError.message : String(settingsError)),
          databaseCode: databaseError?.code,
        }
      );
      session.setHighConcurrencyModeEnabled(false);
      session.setRawCrossProviderFallbackEnabled(false);
    }

    // 自动检测请求格式（端点优先，请求体补充）
    if (session.originalFormat === "claude") {
      // 第一步：尝试端点检测（优先级最高，最准确）
      const endpointFormat = detectFormatByEndpoint(session.requestUrl.pathname);

      if (endpointFormat) {
        session.setOriginalFormat(endpointFormat);
        logger.debug("[ProxyHandler] Detected format by endpoint", {
          endpoint: session.requestUrl.pathname,
          format: endpointFormat,
        });
      } else {
        // 第二步：降级到请求体检测（作为 fallback）
        const detectedFormat = detectClientFormat(
          session.request.message as Record<string, unknown>
        );
        session.setOriginalFormat(detectedFormat);

        if (detectedFormat !== "claude") {
          logger.debug("[ProxyHandler] Detected format by request body (endpoint unknown)", {
            format: detectedFormat,
            endpoint: session.requestUrl.pathname,
            hasContents: Array.isArray(
              (session.request.message as Record<string, unknown>).contents
            ),
            hasRequest:
              typeof (session.request.message as Record<string, unknown>).request === "object",
          });
        }
      }
    }

    // Response API input rectifier: normalize non-array input before guard pipeline
    if (session.originalFormat === "response") {
      await normalizeResponseInput(session);
    }

    // Build guard pipeline from session endpoint policy
    const pipeline = GuardPipelineBuilder.fromSession(session);

    // Run guard chain; may return early Response
    const early = await pipeline.run(session);
    if (early) {
      const isReplayServe = early.response.headers.has("x-cch-replay");
      const isHandledWarmup = early.response.status === 200 && session.isWarmupRequest();
      if (!isReplayServe && !isHandledWarmup) {
        await trackObservedSession(session);
      }
      await finalizeFailedRequest(session, early.response);
      return await attachSessionIdToErrorResponse(session.sessionId, early.response);
    }

    const observedSessionIdentity = await trackObservedSession(session);

    // 9. 增加并发计数（在所有检查通过后，请求开始前）- 跳过 count_tokens
    if (session.sessionId && session.getEndpointPolicy().trackConcurrentRequests) {
      await SessionTracker.incrementConcurrentCount(session.sessionId);
      acquiredConcurrencySessionId = session.sessionId;
    }
    if (observedSessionIdentity && session.getEndpointPolicy().trackConcurrentRequests) {
      await SessionTracker.incrementObservedConcurrentCount(observedSessionIdentity);
      acquiredObservedSessionIdentity = observedSessionIdentity;
    }

    // 10. 记录请求开始
    if (session.messageContext && session.provider) {
      const tracker = ProxyStatusTracker.getInstance();
      tracker.startRequest({
        userId: session.messageContext.user.id,
        userName: session.messageContext.user.name,
        requestId: session.messageContext.id,
        keyName: session.messageContext.key.name,
        providerId: session.provider.id,
        providerName: session.provider.name,
        model: session.request.model || "unknown",
      });
    }

    session.recordForwardStart();

    // Fake streaming: if the client-requested model is whitelisted for the
    // current provider group, hand off to the fake-streaming runner which
    // keeps the SSE connection alive with heartbeats while it serially calls
    // upstream and validates the buffered response before emitting it.
    //
    // We do NOT swallow exceptions: `tryFakeStreamingPath` mutates the session
    // (request body, URL) before the forwarder runs. Falling back to the
    // normal flow with a mutated session would either double-hit the upstream
    // (duplicating cost / message context) or leave the request in an
    // inconsistent state. Let the outer error handler turn the failure into a
    // protocol error response instead.
    //
    // Reuse the system settings already loaded above (with its fallback path)
    // instead of re-reading the cache. A transient cache miss must not turn an
    // otherwise-routable request into an error response.
    if (cachedSystemSettings && !isRawPassthroughEndpointPolicy(session.getEndpointPolicy())) {
      const fakeStreamingResponse = await tryFakeStreamingPath(session, cachedSystemSettings);
      if (fakeStreamingResponse) {
        await finalizeFailedRequest(session, fakeStreamingResponse);
        return await attachSessionIdToErrorResponse(session.sessionId, fakeStreamingResponse);
      }
    }

    const explicitCompactionVersion = session.getExplicitCompactionVersion?.() ?? null;
    if (
      explicitCompactionVersion === "v2" &&
      (session.request.message as Record<string, unknown>).stream !== true
    ) {
      throw new ProxyError("remote_compaction_v2_requires_stream", 400);
    }

    if (explicitCompactionVersion === "v2") {
      const compactionSession = session;
      let fallbackErrorMessage: string = ERROR_CODES.INTERNAL_ERROR;
      try {
        const { getLocale } = await import("next-intl/server");
        fallbackErrorMessage = await getErrorMessageServer(
          await getLocale(),
          ERROR_CODES.INTERNAL_ERROR
        );
      } catch {
        // Keep the stable error code when locale resolution is unavailable.
      }
      const ownedConcurrencySessionId = acquiredConcurrencySessionId;
      const ownedObservedSessionIdentity = acquiredObservedSessionIdentity;
      acquiredConcurrencySessionId = null;
      acquiredObservedSessionIdentity = null;
      return createExplicitCompactionV2HeartbeatResponse({
        fallbackErrorMessage,
        requestId:
          compactionSession.messageContext?.id != null
            ? String(compactionSession.messageContext.id)
            : null,
        execute: async () => {
          try {
            const response = await ProxyForwarder.send(compactionSession);
            return await ProxyResponseHandler.dispatch(compactionSession, response);
          } catch (error) {
            return await ProxyErrorHandler.handle(compactionSession, error);
          }
        },
        onSettled: async () => {
          await Promise.allSettled([
            ownedConcurrencySessionId
              ? SessionTracker.decrementConcurrentCount(ownedConcurrencySessionId)
              : Promise.resolve(),
            ownedObservedSessionIdentity
              ? SessionTracker.decrementObservedConcurrentCount(ownedObservedSessionIdentity)
              : Promise.resolve(),
          ]);
        },
      });
    }

    const response = await ProxyForwarder.send(session);
    const handled = await ProxyResponseHandler.dispatch(session, response);
    const finalResponse = await attachSessionIdToErrorResponse(session.sessionId, handled);
    await finalizeFailedRequest(session, finalResponse);

    return finalResponse;
  } catch (error) {
    const databaseError = findSafeDatabaseError(error);
    logger.error("Proxy handler error:", {
      error: attachSessionIdToErrorMessage(
        session?.sessionId,
        databaseError?.message ?? (error instanceof Error ? error.message : String(error))
      ),
      cch_session_id: session?.sessionId,
      databaseCode: databaseError?.code,
      databasePool: databaseError?.pool,
    });
    if (session) {
      const response = await ProxyErrorHandler.handle(session, error);
      await finalizeFailedRequest(session, response, error);
      return response;
    }

    if (error instanceof ProxyError) {
      return ProxyResponses.buildError(error.statusCode, error.getClientSafeMessage());
    }

    return ProxyResponses.buildError(500, "代理请求发生未知错误");
  } finally {
    // 11. 减少并发计数（确保无论成功失败都执行）- 跳过 count_tokens
    if (acquiredConcurrencySessionId) {
      await SessionTracker.decrementConcurrentCount(acquiredConcurrencySessionId);
    }
    if (acquiredObservedSessionIdentity) {
      await SessionTracker.decrementObservedConcurrentCount(acquiredObservedSessionIdentity);
    }
  }
}
