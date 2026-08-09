"use server";

import { revalidatePath } from "next/cache";
import { locales } from "@/i18n/config";
import { emitActionAudit } from "@/lib/audit/emit";
import { getSession } from "@/lib/auth";
import {
  ClientVersionPolicyError,
  createAutomaticPoliciesForAllUnconfigured,
  createClientVersionPolicy as createPolicy,
  getCachedClientVersionPolicies,
  getCachedClientVersionPolicy,
  overrideClientVersionPolicy as overridePolicy,
  removeClientVersionPolicy as removePolicy,
  updateClientVersionPolicy as updatePolicy,
} from "@/lib/client-version-policy-service";
import { logger } from "@/lib/logger";
import type { ClientVersionPolicy, ClientVersionPolicyWrite } from "@/types/client-version-policy";
import type { ActionResult } from "./types";

export async function listClientVersionPolicies(): Promise<ActionResult<ClientVersionPolicy[]>> {
  const session = await getSession();
  if (session?.user.role !== "admin") return forbidden();
  try {
    return { ok: true, data: await getCachedClientVersionPolicies() };
  } catch (error) {
    logger.error({ error }, "[ClientVersionPolicyAction] Failed to list policies");
    return operationFailed(error);
  }
}

export async function createClientVersionPolicy(
  clientType: string,
  input: ClientVersionPolicyWrite
): Promise<ActionResult<ClientVersionPolicy>> {
  const session = await getSession();
  if (session?.user.role !== "admin") return forbidden();
  try {
    const created = await createPolicy(clientType, input);
    revalidateClientVersions();
    emitActionAudit({
      category: "system_settings",
      action: "client_version_policy.create",
      targetType: "client_version_policy",
      targetId: created.id,
      targetName: created.clientType,
      after: created,
      success: true,
    });
    return { ok: true, data: created };
  } catch (error) {
    auditFailure("client_version_policy.create", clientType, error);
    return operationFailed(error);
  }
}

export async function updateClientVersionPolicy(
  clientType: string,
  input: ClientVersionPolicyWrite
): Promise<ActionResult<ClientVersionPolicy>> {
  const session = await getSession();
  if (session?.user.role !== "admin") return forbidden();
  const before = await getCachedClientVersionPolicy(clientType);
  try {
    const updated = await updatePolicy(clientType, input);
    revalidateClientVersions();
    emitActionAudit({
      category: "system_settings",
      action: "client_version_policy.update",
      targetType: "client_version_policy",
      targetId: updated.id,
      targetName: updated.clientType,
      before: before ?? undefined,
      after: updated,
      success: true,
    });
    return { ok: true, data: updated };
  } catch (error) {
    auditFailure("client_version_policy.update", clientType, error, before ?? undefined);
    return operationFailed(error);
  }
}

export async function overrideClientVersionPolicy(
  clientType: string,
  selectedVersion: string
): Promise<ActionResult<ClientVersionPolicy>> {
  const session = await getSession();
  if (session?.user.role !== "admin") return forbidden();
  const before = await getCachedClientVersionPolicy(clientType);
  try {
    const updated = await overridePolicy(clientType, selectedVersion);
    revalidateClientVersions();
    emitActionAudit({
      category: "system_settings",
      action: "client_version_policy.update",
      targetType: "client_version_policy",
      targetId: updated.id,
      targetName: updated.clientType,
      before: before ?? undefined,
      after: updated,
      success: true,
    });
    return { ok: true, data: updated };
  } catch (error) {
    auditFailure("client_version_policy.update", clientType, error, before ?? undefined);
    return operationFailed(error);
  }
}

export async function deleteClientVersionPolicy(clientType: string): Promise<ActionResult> {
  const session = await getSession();
  if (session?.user.role !== "admin") return forbidden();
  const before = await getCachedClientVersionPolicy(clientType);
  try {
    const deleted = await removePolicy(clientType);
    revalidateClientVersions();
    emitActionAudit({
      category: "system_settings",
      action: "client_version_policy.delete",
      targetType: "client_version_policy",
      targetId: deleted.id,
      targetName: deleted.clientType,
      before: before ?? deleted,
      success: true,
    });
    return { ok: true };
  } catch (error) {
    auditFailure("client_version_policy.delete", clientType, error, before ?? undefined);
    return operationFailed(error);
  }
}

export async function bulkCreateAutomaticClientVersionPolicies(): Promise<
  ActionResult<{ items: ClientVersionPolicy[]; createdCount: number }>
> {
  const session = await getSession();
  if (session?.user.role !== "admin") return forbidden();
  try {
    const { created } = await createAutomaticPoliciesForAllUnconfigured();
    revalidateClientVersions();
    emitActionAudit({
      category: "system_settings",
      action: "client_version_policy.bulk_create",
      targetType: "client_version_policy",
      targetName: "automatic_baseline",
      after: { clientTypes: created.map((policy) => policy.clientType) },
      success: true,
    });
    return { ok: true, data: { items: created, createdCount: created.length } };
  } catch (error) {
    auditFailure("client_version_policy.bulk_create", "automatic_baseline", error);
    return operationFailed(error);
  }
}

function revalidateClientVersions(): void {
  for (const locale of locales) revalidatePath(`/${locale}/settings/client-versions`);
}

function auditFailure(action: string, clientType: string, error: unknown, before?: unknown): void {
  emitActionAudit({
    category: "system_settings",
    action,
    targetType: "client_version_policy",
    targetName: clientType,
    before,
    success: false,
    errorMessage: error instanceof ClientVersionPolicyError ? error.code : "OPERATION_FAILED",
  });
}

function forbidden(): ActionResult<never> {
  return { ok: false, error: "Admin access is required.", errorCode: "auth.forbidden" };
}

function operationFailed(error: unknown): ActionResult<never> {
  logger.error({ error }, "[ClientVersionPolicyAction] Policy operation failed");
  if (error instanceof ClientVersionPolicyError) {
    return { ok: false, error: error.message, errorCode: error.code };
  }
  return { ok: false, error: "Client version policy operation failed." };
}
