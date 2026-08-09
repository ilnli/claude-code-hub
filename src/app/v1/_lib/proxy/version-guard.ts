import { db } from "@/drizzle/db";
import { messageRequest } from "@/drizzle/schema";
import { ClientVersionChecker } from "@/lib/client-version-checker";
import { getCachedSystemSettings } from "@/lib/config";
import { logger } from "@/lib/logger";
import { getClientTypeDisplayName, parseUserAgent } from "@/lib/ua-parser";
import type { ClientVersionEvaluation } from "@/types/client-version-policy";
import type { ProxySession } from "./session";

export class ProxyVersionGuard {
  static async ensure(session: ProxySession): Promise<Response | null> {
    try {
      const settings = await getCachedSystemSettings();
      if (!settings.enableClientVersionCheck || !session.authState?.user) return null;

      const clientInfo = parseUserAgent(session.userAgent);
      if (!clientInfo) return null;

      const { policy, evaluation } = await ClientVersionChecker.checkVersion(
        clientInfo.clientType,
        clientInfo.version
      );
      if (
        !policy ||
        evaluation.status === "within_range" ||
        evaluation.status === "unchecked" ||
        evaluation.status === "unparseable"
      ) {
        return null;
      }

      const clientDisplayName = getClientTypeDisplayName(clientInfo.clientType);
      await ProxyVersionGuard.logBlockedRequest(session, {
        clientType: clientInfo.clientType,
        version: clientInfo.version,
        evaluation,
      });

      if (evaluation.status === "below_minimum") {
        logger.warn(
          {
            userId: session.authState.user.id,
            clientType: clientInfo.clientType,
            currentVersion: clientInfo.version,
            minimumSupportedVersion: evaluation.minimumVersion,
            maximumSupportedVersion: evaluation.maximumVersion,
          },
          "[ProxyVersionGuard] Client version is below the supported range"
        );
        return ProxyVersionGuard.errorResponse({
          error: {
            type: "client_upgrade_required",
            message: buildBelowMinimumMessage(clientDisplayName, clientInfo.version, evaluation),
            current_version: clientInfo.version,
            comparable_version: evaluation.comparableVersion,
            required_version: evaluation.minimumVersion,
            minimum_supported_version: evaluation.minimumVersion,
            maximum_supported_version: evaluation.maximumVersion,
            client_type: clientInfo.clientType,
            client_display_name: clientDisplayName,
          },
        });
      }

      logger.warn(
        {
          userId: session.authState.user.id,
          clientType: clientInfo.clientType,
          currentVersion: clientInfo.version,
          minimumSupportedVersion: evaluation.minimumVersion,
          maximumSupportedVersion: evaluation.maximumVersion,
        },
        "[ProxyVersionGuard] Client version is above the supported range"
      );
      return ProxyVersionGuard.errorResponse({
        error: {
          type: "client_version_too_new",
          message: buildAboveMaximumMessage(clientDisplayName, clientInfo.version, evaluation),
          current_version: clientInfo.version,
          comparable_version: evaluation.comparableVersion,
          minimum_supported_version: evaluation.minimumVersion,
          maximum_supported_version: evaluation.maximumVersion,
          client_type: clientInfo.clientType,
          client_display_name: clientDisplayName,
        },
      });
    } catch (error) {
      logger.error({ error }, "[ProxyVersionGuard] Version check failed; allowing request");
      return null;
    }
  }

  private static errorResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  private static async logBlockedRequest(
    session: ProxySession,
    detail: {
      clientType: string;
      version: string;
      evaluation: ClientVersionEvaluation;
    }
  ): Promise<void> {
    const authState = session.authState;
    if (!authState?.user || !authState.key || !authState.apiKey) return;

    try {
      await db.insert(messageRequest).values({
        providerId: 0,
        userId: authState.user.id,
        key: authState.apiKey,
        model: session.request.model ?? undefined,
        originalModel: session.getOriginalModel() ?? undefined,
        sessionId: session.sessionId ?? undefined,
        requestSequence: session.getRequestSequence(),
        userAgent: session.userAgent ?? undefined,
        endpoint: session.getEndpoint() ?? undefined,
        messagesCount: session.getMessagesLength(),
        statusCode: 400,
        costUsd: "0",
        blockedBy: "client_version",
        blockedReason: JSON.stringify(detail),
        errorMessage:
          detail.evaluation.status === "below_minimum"
            ? "Client upgrade required"
            : "Client version is newer than the supported range",
      });
    } catch (error) {
      logger.error({ error }, "[ProxyVersionGuard] Failed to record blocked client version");
    }
  }
}

function buildBelowMinimumMessage(
  clientDisplayName: string,
  currentVersion: string,
  evaluation: ClientVersionEvaluation
): string {
  if (evaluation.minimumVersion === evaluation.maximumVersion) {
    return `Your ${clientDisplayName} (v${currentVersion}) is unsupported. Please use v${evaluation.minimumVersion}.`;
  }
  if (evaluation.maximumVersion) {
    return `Your ${clientDisplayName} (v${currentVersion}) is outdated. Please use a version from v${evaluation.minimumVersion} through v${evaluation.maximumVersion}.`;
  }
  return `Your ${clientDisplayName} (v${currentVersion}) is outdated. Please upgrade to v${evaluation.minimumVersion} or later to continue using this service.`;
}

function buildAboveMaximumMessage(
  clientDisplayName: string,
  currentVersion: string,
  evaluation: ClientVersionEvaluation
): string {
  if (evaluation.minimumVersion === evaluation.maximumVersion) {
    return `Your ${clientDisplayName} (v${currentVersion}) is unsupported. Please use v${evaluation.maximumVersion}.`;
  }
  if (evaluation.minimumVersion) {
    return `Your ${clientDisplayName} (v${currentVersion}) is newer than the supported range. Please use a version from v${evaluation.minimumVersion} through v${evaluation.maximumVersion}.`;
  }
  return `Your ${clientDisplayName} (v${currentVersion}) is newer than supported. Please use v${evaluation.maximumVersion} or earlier.`;
}
