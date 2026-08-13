import { ClientVersionChecker } from "@/lib/client-version-checker";
import { getCachedSystemSettings } from "@/lib/config";
import { logger } from "@/lib/logger";
import { getClientTypeDisplayName, parseUserAgent } from "@/lib/ua-parser";
import { getErrorMessageServer } from "@/lib/utils/error-messages";
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
      const blockedReason = JSON.stringify({
        clientType: clientInfo.clientType,
        version: clientInfo.version,
        evaluation,
      });

      if (evaluation.status === "below_minimum") {
        const message = await getVersionErrorMessage(
          "CLIENT_VERSION_UPGRADE_REQUIRED",
          clientDisplayName
        );
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
        session.setTerminalFailureMetadata({
          code: "invalid_request",
          adminMessage: "Client version is below the supported range",
          blockedBy: "client_version",
          blockedReason,
        });
        return ProxyVersionGuard.errorResponse({
          error: {
            type: "client_upgrade_required",
            message,
            required_version: evaluation.minimumVersion,
            minimum_supported_version: evaluation.minimumVersion,
            maximum_supported_version: evaluation.maximumVersion,
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
      const message = await getVersionErrorMessage("CLIENT_VERSION_TOO_NEW", clientDisplayName);
      session.setTerminalFailureMetadata({
        code: "invalid_request",
        adminMessage: "Client version is above the supported range",
        blockedBy: "client_version",
        blockedReason,
      });
      return ProxyVersionGuard.errorResponse({
        error: {
          type: "client_version_too_new",
          message,
          minimum_supported_version: evaluation.minimumVersion,
          maximum_supported_version: evaluation.maximumVersion,
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
}

async function getVersionErrorMessage(code: string, clientDisplayName: string): Promise<string> {
  try {
    const { getLocale } = await import("next-intl/server");
    return await getErrorMessageServer(await getLocale(), code, { client: clientDisplayName });
  } catch {
    return "This client version is unsupported. Use a supported version and try again.";
  }
}
