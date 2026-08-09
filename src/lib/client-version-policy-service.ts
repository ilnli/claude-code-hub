import "server-only";

import {
  advanceAutomaticBaselineHistory,
  buildFixedPolicyOverride,
  compareClientVersions,
  computeAutomaticVersionBaseline,
  evaluateClientVersion,
  isValidPreviousSeriesTerminal,
  normalizeClientVersion,
} from "@/lib/client-version-policy";
import { logger } from "@/lib/logger";
import { publishCacheInvalidation, subscribeCacheInvalidation } from "@/lib/redis/pubsub";
import { parseUserAgent } from "@/lib/ua-parser";
import {
  type ClientVersionPolicyInsert,
  createClientVersionPolicy as createPolicyRow,
  deleteClientVersionPolicy as deletePolicyRow,
  getClientVersionPolicyInitializationState,
  initializeClientVersionPolicies,
  listClientVersionPolicies,
  updateAutomaticBaselineLocked,
  updateClientVersionPolicy as updatePolicyRow,
} from "@/repository/client-version-policies";
import { getActiveUserVersionsStrict, type RawUserVersion } from "@/repository/client-versions";
import { getSystemSettings } from "@/repository/system-config";
import type {
  ClientVersionEvaluation,
  ClientVersionPolicy,
  ClientVersionPolicyWrite,
} from "@/types/client-version-policy";
import type { SystemSettings, UpdateSystemSettingsInput } from "@/types/system-config";

export const CHANNEL_CLIENT_VERSION_POLICIES_UPDATED = "cch:cache:client-version-policies:updated";

const POLICY_CACHE_TTL_MS = 30_000;
const BASELINE_REFRESH_INTERVAL_MS = 5 * 60_000;

export interface ObservedClientVersion extends RawUserVersion {
  clientType: string;
  version: string;
}

export interface ObservedClientType {
  clientType: string;
  observations: ObservedClientVersion[];
}

export class ClientVersionPolicyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "CLIENT_TYPE_NOT_OBSERVED"
      | "POLICY_ALREADY_EXISTS"
      | "POLICY_NOT_FOUND"
      | "POLICY_INPUT_INVALID"
      | "PREVIOUS_SERIES_INVALID"
      | "BASELINE_UNAVAILABLE"
  ) {
    super(message);
    this.name = "ClientVersionPolicyError";
  }
}

const policyCache: {
  policies: ClientVersionPolicy[] | null;
  expiresAt: number;
  refreshPromise: Promise<ClientVersionPolicy[]> | null;
} = {
  policies: null,
  expiresAt: 0,
  refreshPromise: null,
};

let subscriptionInitialized = false;
let subscriptionPromise: Promise<void> | null = null;
const baselineRefreshAt = new Map<string, number>();
const baselineRefreshPromises = new Map<string, Promise<ClientVersionPolicy>>();

const schedulerState = globalThis as typeof globalThis & {
  __CCH_CLIENT_VERSION_POLICY_INIT_INTERVAL__?: ReturnType<typeof setInterval>;
};

export function getClientVersionAdoptionThreshold(): number {
  const raw = process.env.CLIENT_VERSION_GA_THRESHOLD;
  const parsed = raw ? Number.parseInt(raw, 10) : 2;
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 10);
}

export async function getObservedClientTypes(days = 7): Promise<ObservedClientType[]> {
  const activeUsers = await getActiveUserVersionsStrict(days);
  const groups = new Map<string, ObservedClientVersion[]>();

  for (const user of activeUsers) {
    const clientInfo = parseUserAgent(user.userAgent);
    if (!clientInfo) continue;
    const observations = groups.get(clientInfo.clientType) ?? [];
    observations.push({
      ...user,
      clientType: clientInfo.clientType,
      version: clientInfo.version,
    });
    groups.set(clientInfo.clientType, observations);
  }

  return Array.from(groups, ([clientType, observations]) => ({ clientType, observations })).sort(
    (a, b) => a.clientType.localeCompare(b.clientType)
  );
}

async function ensurePolicyCacheSubscription(): Promise<void> {
  if (subscriptionInitialized || subscriptionPromise)
    return subscriptionPromise ?? Promise.resolve();
  if (process.env.CI === "true" || process.env.NEXT_PHASE === "phase-production-build") {
    subscriptionInitialized = true;
    return;
  }

  subscriptionPromise = subscribeCacheInvalidation(CHANNEL_CLIENT_VERSION_POLICIES_UPDATED, () => {
    invalidateClientVersionPolicyCache();
  })
    .then((cleanup) => {
      if (cleanup) subscriptionInitialized = true;
    })
    .finally(() => {
      subscriptionPromise = null;
    });
  return subscriptionPromise;
}

export function invalidateClientVersionPolicyCache(): void {
  policyCache.policies = null;
  policyCache.expiresAt = 0;
  policyCache.refreshPromise = null;
}

export async function publishClientVersionPolicyInvalidation(): Promise<void> {
  invalidateClientVersionPolicyCache();
  await publishCacheInvalidation(CHANNEL_CLIENT_VERSION_POLICIES_UPDATED);
}

export async function getCachedClientVersionPolicies(): Promise<ClientVersionPolicy[]> {
  void ensurePolicyCacheSubscription();
  if (policyCache.policies && policyCache.expiresAt > Date.now()) return policyCache.policies;
  if (policyCache.refreshPromise) return policyCache.refreshPromise;

  policyCache.refreshPromise = listClientVersionPolicies()
    .then((policies) => {
      policyCache.policies = policies;
      policyCache.expiresAt = Date.now() + POLICY_CACHE_TTL_MS;
      return policies;
    })
    .finally(() => {
      policyCache.refreshPromise = null;
    });
  return policyCache.refreshPromise;
}

export async function getCachedClientVersionPolicy(
  clientType: string
): Promise<ClientVersionPolicy | null> {
  const policies = await getCachedClientVersionPolicies();
  return policies.find((policy) => policy.clientType === clientType) ?? null;
}

function versionsForBaseline(group: ObservedClientType | undefined) {
  return (group?.observations ?? []).map((observation) => ({
    userId: observation.userId,
    version: observation.version,
  }));
}

function buildAutomaticPolicyInsert(group: ObservedClientType): ClientVersionPolicyInsert {
  const automaticBaseline = computeAutomaticVersionBaseline(
    versionsForBaseline(group),
    getClientVersionAdoptionThreshold()
  );
  return {
    clientType: group.clientType,
    mode: "automatic_baseline",
    automaticBaseline,
    baselineUpdatedAt: automaticBaseline ? new Date() : null,
  };
}

export async function initializePoliciesWithSettings(
  settingsPayload: UpdateSystemSettingsInput = {}
): Promise<{ settings: SystemSettings; initializedNow: boolean; policiesCreated: number }> {
  await getSystemSettings();
  const state = await getClientVersionPolicyInitializationState();
  const shouldInitialize =
    state.enableClientVersionCheck || settingsPayload.enableClientVersionCheck;
  const policies =
    !state.initialized && shouldInitialize
      ? (await getObservedClientTypes()).map(buildAutomaticPolicyInsert)
      : [];
  const result = await initializeClientVersionPolicies(policies, settingsPayload);
  if (result.initializedNow) await publishClientVersionPolicyInvalidation();
  return result;
}

export async function attemptStartupPolicyInitialization(): Promise<boolean> {
  try {
    await getSystemSettings();
    const state = await getClientVersionPolicyInitializationState();
    if (!state.enableClientVersionCheck || state.initialized) return state.initialized;
    const result = await initializePoliciesWithSettings();
    logger.info("[ClientVersionPolicy] Policy initialization completed", {
      policiesCreated: result.policiesCreated,
    });
    return true;
  } catch (error) {
    logger.warn(
      "[ClientVersionPolicy] Policy initialization failed; enforcement remains fail-open",
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return false;
  }
}

export function startClientVersionPolicyInitializationScheduler(): void {
  if (schedulerState.__CCH_CLIENT_VERSION_POLICY_INIT_INTERVAL__) return;

  const run = async () => {
    if (await attemptStartupPolicyInitialization()) {
      stopClientVersionPolicyInitializationScheduler();
    }
  };
  schedulerState.__CCH_CLIENT_VERSION_POLICY_INIT_INTERVAL__ = setInterval(() => {
    void run();
  }, BASELINE_REFRESH_INTERVAL_MS);
  void run();
}

export function stopClientVersionPolicyInitializationScheduler(): void {
  const timer = schedulerState.__CCH_CLIENT_VERSION_POLICY_INIT_INTERVAL__;
  if (!timer) return;
  clearInterval(timer);
  delete schedulerState.__CCH_CLIENT_VERSION_POLICY_INIT_INTERVAL__;
}

async function refreshAutomaticBaseline(
  policy: ClientVersionPolicy,
  force = false
): Promise<ClientVersionPolicy> {
  if (policy.mode !== "automatic_baseline" && policy.mode !== "baseline_lag") return policy;
  if (!force && (baselineRefreshAt.get(policy.clientType) ?? 0) > Date.now()) return policy;

  const running = baselineRefreshPromises.get(policy.clientType);
  if (running) return running;

  const refresh = (async () => {
    const group = (await getObservedClientTypes()).find(
      (candidate) => candidate.clientType === policy.clientType
    );
    const candidateBaseline = computeAutomaticVersionBaseline(
      versionsForBaseline(group),
      getClientVersionAdoptionThreshold()
    );
    const updated = await updateAutomaticBaselineLocked(policy.clientType, (current) => {
      if (current.mode !== "automatic_baseline" && current.mode !== "baseline_lag") return null;
      const next = advanceAutomaticBaselineHistory(
        current.automaticBaseline,
        candidateBaseline,
        current.previousSeriesTerminalVersion
      );
      if (!next.changed) return null;
      return {
        automaticBaseline: next.automaticBaseline,
        previousSeriesTerminalVersion: next.previousSeriesTerminalVersion,
        baselineUpdatedAt: new Date(),
      };
    });
    if (!updated) throw new Error(`Client version policy not found: ${policy.clientType}`);

    baselineRefreshAt.set(policy.clientType, Date.now() + BASELINE_REFRESH_INTERVAL_MS);
    if (
      updated.automaticBaseline !== policy.automaticBaseline ||
      updated.previousSeriesTerminalVersion !== policy.previousSeriesTerminalVersion
    ) {
      logger.info("[ClientVersionPolicy] Automatic baseline advanced", {
        clientType: policy.clientType,
        previousBaseline: policy.automaticBaseline,
        automaticBaseline: updated.automaticBaseline,
        previousSeriesTerminalVersion: updated.previousSeriesTerminalVersion,
      });
      await publishClientVersionPolicyInvalidation();
    }
    return updated;
  })().finally(() => {
    baselineRefreshPromises.delete(policy.clientType);
  });

  baselineRefreshPromises.set(policy.clientType, refresh);
  return refresh;
}

export async function evaluateClientVersionPolicy(
  clientType: string,
  rawVersion: string
): Promise<{ policy: ClientVersionPolicy | null; evaluation: ClientVersionEvaluation }> {
  let policy = await getCachedClientVersionPolicy(clientType);
  if (policy && (policy.mode === "automatic_baseline" || policy.mode === "baseline_lag")) {
    policy = await refreshAutomaticBaseline(policy);
  }
  return { policy, evaluation: evaluateClientVersion(rawVersion, policy) };
}

function normalizePolicyWrite(input: ClientVersionPolicyWrite): ClientVersionPolicyWrite {
  switch (input.mode) {
    case "automatic_baseline":
      return input;
    case "minimum": {
      const minimumVersion = normalizeClientVersion(input.minimumVersion);
      if (!minimumVersion) throw invalidPolicyInput();
      return { mode: input.mode, minimumVersion };
    }
    case "maximum": {
      const maximumVersion = normalizeClientVersion(input.maximumVersion);
      if (!maximumVersion) throw invalidPolicyInput();
      return { mode: input.mode, maximumVersion };
    }
    case "range": {
      const minimumVersion = normalizeClientVersion(input.minimumVersion);
      const maximumVersion = normalizeClientVersion(input.maximumVersion);
      if (
        !minimumVersion ||
        !maximumVersion ||
        compareClientVersions(minimumVersion, maximumVersion) === 1
      ) {
        throw invalidPolicyInput();
      }
      return { mode: input.mode, minimumVersion, maximumVersion };
    }
    case "baseline_lag":
      if (!Number.isSafeInteger(input.baselineLag) || input.baselineLag <= 0) {
        throw invalidPolicyInput();
      }
      return input;
  }
}

function invalidPolicyInput() {
  return new ClientVersionPolicyError(
    "Invalid client version policy input",
    "POLICY_INPUT_INVALID"
  );
}

function toPolicyInsert(
  clientType: string,
  write: ClientVersionPolicyWrite,
  baseline: string | null,
  previousSeriesTerminalVersion: string | null
): ClientVersionPolicyInsert {
  return {
    clientType,
    mode: write.mode,
    minimumVersion:
      write.mode === "minimum" || write.mode === "range" ? write.minimumVersion : null,
    maximumVersion:
      write.mode === "maximum" || write.mode === "range" ? write.maximumVersion : null,
    baselineLag: write.mode === "baseline_lag" ? write.baselineLag : null,
    automaticBaseline: baseline,
    previousSeriesTerminalVersion,
    baselineUpdatedAt: baseline ? new Date() : null,
  };
}

function validatePreviousSeriesTerminal(
  baseline: string | null,
  previousSeriesTerminalVersion: string | null | undefined
): string | null {
  if (previousSeriesTerminalVersion == null) return null;
  const normalized = normalizeClientVersion(previousSeriesTerminalVersion);
  if (!baseline) {
    throw new ClientVersionPolicyError(
      "An automatic baseline is required before setting the previous series terminal version",
      "BASELINE_UNAVAILABLE"
    );
  }
  if (!normalized || !isValidPreviousSeriesTerminal(baseline, normalized)) {
    throw new ClientVersionPolicyError(
      "The previous series terminal version must be lower and belong to another version series",
      "PREVIOUS_SERIES_INVALID"
    );
  }
  return normalized;
}

async function requireObservedClientType(clientType: string): Promise<ObservedClientType> {
  const group = (await getObservedClientTypes()).find(
    (candidate) => candidate.clientType === clientType
  );
  if (!group) {
    throw new ClientVersionPolicyError(
      "Client type has not been observed in the current window",
      "CLIENT_TYPE_NOT_OBSERVED"
    );
  }
  return group;
}

export async function createClientVersionPolicy(
  clientType: string,
  input: ClientVersionPolicyWrite
): Promise<ClientVersionPolicy> {
  if (await getCachedClientVersionPolicy(clientType)) {
    throw new ClientVersionPolicyError(
      "Client version policy already exists",
      "POLICY_ALREADY_EXISTS"
    );
  }
  const group = await requireObservedClientType(clientType);
  const write = normalizePolicyWrite(input);
  const baselineDriven = write.mode === "automatic_baseline" || write.mode === "baseline_lag";
  const baseline = baselineDriven
    ? computeAutomaticVersionBaseline(
        versionsForBaseline(group),
        getClientVersionAdoptionThreshold()
      )
    : null;
  const previousSeriesTerminalVersion =
    write.mode === "baseline_lag"
      ? validatePreviousSeriesTerminal(baseline, write.previousSeriesTerminalVersion)
      : null;
  const created = await createPolicyRow(
    toPolicyInsert(clientType, write, baseline, previousSeriesTerminalVersion)
  );
  await publishClientVersionPolicyInvalidation();
  return created;
}

export async function updateClientVersionPolicy(
  clientType: string,
  input: ClientVersionPolicyWrite
): Promise<ClientVersionPolicy> {
  const current = await getCachedClientVersionPolicy(clientType);
  if (!current)
    throw new ClientVersionPolicyError("Client version policy not found", "POLICY_NOT_FOUND");
  const write = normalizePolicyWrite(input);
  const currentBaselineDriven =
    current.mode === "automatic_baseline" || current.mode === "baseline_lag";
  const nextBaselineDriven = write.mode === "automatic_baseline" || write.mode === "baseline_lag";

  let baseline = nextBaselineDriven && currentBaselineDriven ? current.automaticBaseline : null;
  let previousSeriesTerminalVersion = current.previousSeriesTerminalVersion;
  if (nextBaselineDriven && !currentBaselineDriven) {
    const group = await requireObservedClientType(clientType);
    baseline = computeAutomaticVersionBaseline(
      versionsForBaseline(group),
      getClientVersionAdoptionThreshold()
    );
    if (
      !baseline ||
      !previousSeriesTerminalVersion ||
      !isValidPreviousSeriesTerminal(baseline, previousSeriesTerminalVersion)
    ) {
      previousSeriesTerminalVersion = null;
    }
  }
  if (write.mode === "baseline_lag" && write.previousSeriesTerminalVersion !== undefined) {
    previousSeriesTerminalVersion = validatePreviousSeriesTerminal(
      baseline,
      write.previousSeriesTerminalVersion
    );
  }

  const updated = await updatePolicyRow(
    clientType,
    toPolicyInsert(clientType, write, baseline, previousSeriesTerminalVersion)
  );
  if (!updated)
    throw new ClientVersionPolicyError("Client version policy not found", "POLICY_NOT_FOUND");
  baselineRefreshAt.delete(clientType);
  await publishClientVersionPolicyInvalidation();
  return updated;
}

export async function overrideClientVersionPolicy(
  clientType: string,
  selectedVersion: string
): Promise<ClientVersionPolicy> {
  const current = await getCachedClientVersionPolicy(clientType);
  if (!current)
    throw new ClientVersionPolicyError("Client version policy not found", "POLICY_NOT_FOUND");
  const override = buildFixedPolicyOverride(current, selectedVersion);
  if (!override) throw invalidPolicyInput();
  return updateClientVersionPolicy(clientType, override);
}

export async function removeClientVersionPolicy(clientType: string): Promise<ClientVersionPolicy> {
  const deleted = await deletePolicyRow(clientType);
  if (!deleted)
    throw new ClientVersionPolicyError("Client version policy not found", "POLICY_NOT_FOUND");
  baselineRefreshAt.delete(clientType);
  await publishClientVersionPolicyInvalidation();
  return deleted;
}

export async function createAutomaticPoliciesForAllUnconfigured(): Promise<{
  created: ClientVersionPolicy[];
}> {
  const [groups, policies] = await Promise.all([
    getObservedClientTypes(),
    getCachedClientVersionPolicies(),
  ]);
  const configured = new Set(policies.map((policy) => policy.clientType));
  const created: ClientVersionPolicy[] = [];
  for (const group of groups) {
    if (configured.has(group.clientType)) continue;
    created.push(await createPolicyRow(buildAutomaticPolicyInsert(group)));
  }
  if (created.length > 0) await publishClientVersionPolicyInvalidation();
  return { created };
}
