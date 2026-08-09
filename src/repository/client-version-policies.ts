"use server";

import { asc, eq } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { clientVersionPolicies, systemSettings } from "@/drizzle/schema";
import type { ClientVersionPolicy, ClientVersionPolicyMode } from "@/types/client-version-policy";
import type { SystemSettings, UpdateSystemSettingsInput } from "@/types/system-config";
import { updateSystemSettings } from "./system-config";

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ClientVersionPolicyInsert {
  clientType: string;
  mode: ClientVersionPolicyMode;
  minimumVersion?: string | null;
  maximumVersion?: string | null;
  baselineLag?: number | null;
  automaticBaseline?: string | null;
  previousSeriesTerminalVersion?: string | null;
  baselineUpdatedAt?: Date | null;
}

export interface ClientVersionPolicyUpdate {
  mode?: ClientVersionPolicyMode;
  minimumVersion?: string | null;
  maximumVersion?: string | null;
  baselineLag?: number | null;
  automaticBaseline?: string | null;
  previousSeriesTerminalVersion?: string | null;
  baselineUpdatedAt?: Date | null;
}

function toPolicy(row: typeof clientVersionPolicies.$inferSelect): ClientVersionPolicy {
  return {
    id: row.id,
    clientType: row.clientType,
    mode: row.mode,
    minimumVersion: row.minimumVersion,
    maximumVersion: row.maximumVersion,
    baselineLag: row.baselineLag,
    automaticBaseline: row.automaticBaseline,
    previousSeriesTerminalVersion: row.previousSeriesTerminalVersion,
    baselineUpdatedAt: row.baselineUpdatedAt ? new Date(row.baselineUpdatedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export async function listClientVersionPolicies(): Promise<ClientVersionPolicy[]> {
  const rows = await db
    .select()
    .from(clientVersionPolicies)
    .orderBy(asc(clientVersionPolicies.clientType));
  return rows.map(toPolicy);
}

export async function getClientVersionPolicyInitializationState(): Promise<{
  enableClientVersionCheck: boolean;
  initialized: boolean;
}> {
  const [row] = await db
    .select({
      enableClientVersionCheck: systemSettings.enableClientVersionCheck,
      initialized: systemSettings.clientVersionPolicyInitialized,
    })
    .from(systemSettings)
    .orderBy(asc(systemSettings.id))
    .limit(1);
  return {
    enableClientVersionCheck: row?.enableClientVersionCheck ?? false,
    initialized: row?.initialized ?? false,
  };
}

export async function getClientVersionPolicy(
  clientType: string,
  executor: typeof db | TransactionExecutor = db
): Promise<ClientVersionPolicy | null> {
  const [row] = await executor
    .select()
    .from(clientVersionPolicies)
    .where(eq(clientVersionPolicies.clientType, clientType))
    .limit(1);
  return row ? toPolicy(row) : null;
}

export async function createClientVersionPolicy(
  input: ClientVersionPolicyInsert,
  executor: typeof db | TransactionExecutor = db
): Promise<ClientVersionPolicy> {
  const [created] = await executor.insert(clientVersionPolicies).values(input).returning();
  if (!created) throw new Error("Failed to create client version policy");
  return toPolicy(created);
}

export async function updateClientVersionPolicy(
  clientType: string,
  update: ClientVersionPolicyUpdate,
  executor: typeof db | TransactionExecutor = db
): Promise<ClientVersionPolicy | null> {
  const [updated] = await executor
    .update(clientVersionPolicies)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(clientVersionPolicies.clientType, clientType))
    .returning();
  return updated ? toPolicy(updated) : null;
}

export async function deleteClientVersionPolicy(
  clientType: string
): Promise<ClientVersionPolicy | null> {
  const [deleted] = await db
    .delete(clientVersionPolicies)
    .where(eq(clientVersionPolicies.clientType, clientType))
    .returning();
  return deleted ? toPolicy(deleted) : null;
}

export async function updateAutomaticBaselineLocked(
  clientType: string,
  updater: (current: ClientVersionPolicy) => ClientVersionPolicyUpdate | null
): Promise<ClientVersionPolicy | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(clientVersionPolicies)
      .where(eq(clientVersionPolicies.clientType, clientType))
      .limit(1)
      .for("update");
    if (!row) return null;

    const current = toPolicy(row);
    const update = updater(current);
    if (!update) return current;
    return updateClientVersionPolicy(clientType, update, tx);
  });
}

export async function initializeClientVersionPolicies(
  policies: ClientVersionPolicyInsert[],
  settingsPayload: UpdateSystemSettingsInput = {}
): Promise<{ settings: SystemSettings; initializedNow: boolean; policiesCreated: number }> {
  return db.transaction(async (tx) => {
    const [lockedSettings] = await tx
      .select()
      .from(systemSettings)
      .orderBy(asc(systemSettings.id))
      .limit(1)
      .for("update");
    if (!lockedSettings) {
      throw new Error("System settings must exist before client version policy initialization");
    }

    const shouldEnable = settingsPayload.enableClientVersionCheck === true;
    const shouldInitialize = lockedSettings.enableClientVersionCheck || shouldEnable;
    if (lockedSettings.clientVersionPolicyInitialized || !shouldInitialize) {
      const settings = await updateSystemSettings(settingsPayload, tx);
      return { settings, initializedNow: false, policiesCreated: 0 };
    }

    let policiesCreated = 0;
    if (policies.length > 0) {
      const inserted = await tx
        .insert(clientVersionPolicies)
        .values(policies)
        .onConflictDoNothing({ target: clientVersionPolicies.clientType })
        .returning({ id: clientVersionPolicies.id });
      policiesCreated = inserted.length;
    }

    const settings = await updateSystemSettings(
      { ...settingsPayload, clientVersionPolicyInitialized: true },
      tx
    );
    return { settings, initializedNow: true, policiesCreated };
  });
}
