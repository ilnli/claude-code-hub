import { evaluateClientVersion, normalizeClientVersion } from "@/lib/client-version-policy";
import {
  evaluateClientVersionPolicy,
  getCachedClientVersionPolicies,
} from "@/lib/client-version-policy-service";
import { logger } from "@/lib/logger";
import { parseUserAgent } from "@/lib/ua-parser";
import { getActiveUserVersions } from "@/repository/client-versions";
import { getSystemSettings } from "@/repository/system-config";
import type {
  ClientVersionEvaluation,
  ClientVersionPolicy,
  ClientVersionStatus,
} from "@/types/client-version-policy";

export interface ClientVersionStats {
  clientType: string;
  /** Deprecated compatibility alias for automaticBaseline. */
  gaVersion: string | null;
  automaticBaseline: string | null;
  effectiveMinimumVersion: string | null;
  effectiveMaximumVersion: string | null;
  waitingForBaseline: boolean;
  enforcementActive: boolean;
  policy: ClientVersionPolicy | null;
  totalUsers: number;
  users: {
    userId: number;
    username: string;
    version: string;
    comparableVersion: string | null;
    lastSeen: Date;
    status: ClientVersionStatus;
    /** Deprecated: true only for versions below the effective minimum. */
    needsUpgrade: boolean;
    /** Deprecated: true only when equal to an automatic baseline. */
    isLatest: boolean;
  }[];
}

export class ClientVersionChecker {
  static async checkVersion(
    clientType: string,
    version: string
  ): Promise<{ policy: ClientVersionPolicy | null; evaluation: ClientVersionEvaluation }> {
    return evaluateClientVersionPolicy(clientType, version);
  }

  static async getAllClientStats(): Promise<ClientVersionStats[]> {
    try {
      const [activeUsers, policies, settings] = await Promise.all([
        getActiveUserVersions(7),
        getCachedClientVersionPolicies(),
        getSystemSettings(),
      ]);
      const policiesByType = new Map(policies.map((policy) => [policy.clientType, policy]));
      const groups = new Map<
        string,
        Array<{
          userId: number;
          username: string;
          version: string;
          lastSeen: Date;
        }>
      >();

      for (const user of activeUsers) {
        const clientInfo = parseUserAgent(user.userAgent);
        if (!clientInfo) continue;
        const observations = groups.get(clientInfo.clientType) ?? [];
        observations.push({
          userId: user.userId,
          username: user.username,
          version: clientInfo.version,
          lastSeen: user.lastSeen,
        });
        groups.set(clientInfo.clientType, observations);
      }

      const clientTypes = new Set([...groups.keys(), ...policiesByType.keys()]);
      const stats: ClientVersionStats[] = [];
      for (const clientType of Array.from(clientTypes).sort()) {
        const policy = policiesByType.get(clientType) ?? null;
        const uniqueUsers = deduplicateUserVersions(groups.get(clientType) ?? []);
        const userStats = uniqueUsers.map((user) => {
          const evaluation = evaluateClientVersion(user.version, policy);
          return {
            ...user,
            comparableVersion: evaluation.comparableVersion,
            status: evaluation.status,
            needsUpgrade: evaluation.status === "below_minimum",
            isLatest:
              policy?.automaticBaseline != null &&
              evaluation.comparableVersion === policy.automaticBaseline,
          };
        });
        const range = evaluateClientVersion("0.0.0", policy);
        const baselineDriven =
          policy?.mode === "automatic_baseline" || policy?.mode === "baseline_lag";
        stats.push({
          clientType,
          gaVersion: baselineDriven ? policy.automaticBaseline : null,
          automaticBaseline: baselineDriven ? policy.automaticBaseline : null,
          effectiveMinimumVersion: range.minimumVersion,
          effectiveMaximumVersion: range.maximumVersion,
          waitingForBaseline: range.waitingForBaseline,
          enforcementActive: settings.enableClientVersionCheck && policy !== null,
          policy,
          totalUsers: userStats.length,
          users: userStats,
        });
      }
      return stats;
    } catch (error) {
      logger.error({ error }, "[ClientVersionChecker] Failed to get client version statistics");
      return [];
    }
  }
}

function deduplicateUserVersions(
  observations: Array<{
    userId: number;
    username: string;
    version: string;
    lastSeen: Date;
  }>
) {
  const byUser = new Map<number, (typeof observations)[number]>();
  for (const observation of observations) {
    const current = byUser.get(observation.userId);
    if (!current) {
      byUser.set(observation.userId, observation);
      continue;
    }

    const currentVersion = normalizeClientVersion(current.version);
    const nextVersion = normalizeClientVersion(observation.version);
    if (
      (!currentVersion && nextVersion) ||
      (currentVersion && nextVersion && compareNormalized(nextVersion, currentVersion) > 0) ||
      (currentVersion === nextVersion && observation.lastSeen > current.lastSeen)
    ) {
      byUser.set(observation.userId, observation);
    }
  }
  return Array.from(byUser.values());
}

function compareNormalized(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}
