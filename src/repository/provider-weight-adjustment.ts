import { and, asc, desc, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import {
  providers,
  providerWeightAdjustmentRuleMembers,
  providerWeightAdjustmentRules,
  providerWeightAdjustmentRunDetails,
  providerWeightAdjustmentRuns,
  systemSettings,
} from "@/drizzle/schema";
import type {
  WeightAdjustmentMemberInput,
  WeightAdjustmentPreview,
} from "@/lib/provider-weight-adjustment/calculation";
import { calculateProviderWeightAdjustment } from "@/lib/provider-weight-adjustment/calculation";
import type { ProviderType } from "@/types/provider";
import type {
  ProviderWeightAdjustmentDetailOutcome,
  ProviderWeightAdjustmentFaultKind,
  ProviderWeightAdjustmentIntervalMinutes,
  ProviderWeightAdjustmentRule,
  ProviderWeightAdjustmentRun,
  ProviderWeightAdjustmentRunDetail,
  ProviderWeightAdjustmentRunStatus,
  ProviderWeightAdjustmentRunSummary,
  ProviderWeightAdjustmentTrigger,
} from "@/types/provider-weight-adjustment";

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ReadExecutor = Pick<TransactionExecutor, "select">;
type MutationExecutor = Pick<TransactionExecutor, "select" | "insert" | "update" | "delete">;

const EMPTY_SUMMARY: ProviderWeightAdjustmentRunSummary = {
  memberCount: 0,
  participantCount: 0,
  changedCount: 0,
  skippedCount: 0,
  failedCount: 0,
};

export class ProviderWeightAdjustmentError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ProviderWeightAdjustmentError";
  }
}

function toRule(
  row: typeof providerWeightAdjustmentRules.$inferSelect
): ProviderWeightAdjustmentRule {
  return {
    ...row,
    faultKind: row.faultKind as ProviderWeightAdjustmentFaultKind | null,
  };
}

function toRun(row: typeof providerWeightAdjustmentRuns.$inferSelect): ProviderWeightAdjustmentRun {
  return {
    ...row,
    trigger: row.trigger as ProviderWeightAdjustmentTrigger,
    status: row.status as ProviderWeightAdjustmentRunStatus,
  };
}

function toRunDetail(
  row: typeof providerWeightAdjustmentRunDetails.$inferSelect
): ProviderWeightAdjustmentRunDetail {
  return {
    ...row,
    outcome: row.outcome as ProviderWeightAdjustmentDetailOutcome,
  };
}

async function selectRule(
  executor: ReadExecutor,
  ruleId: number
): Promise<ProviderWeightAdjustmentRule | null> {
  const [row] = await executor
    .select()
    .from(providerWeightAdjustmentRules)
    .where(
      and(
        eq(providerWeightAdjustmentRules.id, ruleId),
        isNull(providerWeightAdjustmentRules.deletedAt)
      )
    )
    .limit(1);
  return row ? toRule(row) : null;
}

export async function getProviderWeightAdjustmentRule(
  ruleId: number
): Promise<ProviderWeightAdjustmentRule | null> {
  return selectRule(db, ruleId);
}

export async function listProviderWeightAdjustmentRules(): Promise<ProviderWeightAdjustmentRule[]> {
  const rows = await db
    .select()
    .from(providerWeightAdjustmentRules)
    .where(isNull(providerWeightAdjustmentRules.deletedAt))
    .orderBy(asc(providerWeightAdjustmentRules.name), asc(providerWeightAdjustmentRules.id));
  return rows.map(toRule);
}

export async function listDueProviderWeightAdjustmentRules(
  now: Date
): Promise<ProviderWeightAdjustmentRule[]> {
  const rows = await db
    .select()
    .from(providerWeightAdjustmentRules)
    .where(
      and(
        isNull(providerWeightAdjustmentRules.deletedAt),
        eq(providerWeightAdjustmentRules.isEnabled, true),
        lte(providerWeightAdjustmentRules.nextRunAt, now)
      )
    )
    .orderBy(asc(providerWeightAdjustmentRules.nextRunAt), asc(providerWeightAdjustmentRules.id));
  return rows.map(toRule);
}

async function loadMemberInputs(
  executor: ReadExecutor,
  ruleId: number
): Promise<WeightAdjustmentMemberInput[]> {
  const rows = await executor
    .select({
      providerId: providers.id,
      providerName: providers.name,
      providerType: providers.providerType,
      priority: providers.priority,
      isEnabled: providers.isEnabled,
      costMultiplier: providers.costMultiplier,
      currentWeight: providers.weight,
    })
    .from(providerWeightAdjustmentRuleMembers)
    .innerJoin(providers, eq(providerWeightAdjustmentRuleMembers.providerId, providers.id))
    .where(and(eq(providerWeightAdjustmentRuleMembers.ruleId, ruleId), isNull(providers.deletedAt)))
    .orderBy(asc(providerWeightAdjustmentRuleMembers.id));

  return rows;
}

export async function getProviderWeightAdjustmentPreview(
  ruleId: number
): Promise<{ rule: ProviderWeightAdjustmentRule; preview: WeightAdjustmentPreview } | null> {
  const rule = await selectRule(db, ruleId);
  if (!rule) return null;
  const members = await loadMemberInputs(db, ruleId);
  return {
    rule,
    preview: calculateProviderWeightAdjustment(
      { providerType: rule.providerType, priority: rule.priority },
      members
    ),
  };
}

async function validateMemberIds(
  executor: ReadExecutor,
  input: {
    ruleId?: number;
    providerType: ProviderType;
    priority: number;
    providerIds: number[];
  }
): Promise<WeightAdjustmentMemberInput[]> {
  const providerIds = Array.from(new Set(input.providerIds));
  if (providerIds.length > 500) {
    throw new ProviderWeightAdjustmentError(
      "member_limit_exceeded",
      "A rule can contain at most 500 providers."
    );
  }
  if (providerIds.length === 0) return [];

  const rows = await executor
    .select({
      providerId: providers.id,
      providerName: providers.name,
      providerType: providers.providerType,
      priority: providers.priority,
      isEnabled: providers.isEnabled,
      costMultiplier: providers.costMultiplier,
      currentWeight: providers.weight,
    })
    .from(providers)
    .where(and(inArray(providers.id, providerIds), isNull(providers.deletedAt)));

  if (rows.length !== providerIds.length) {
    throw new ProviderWeightAdjustmentError(
      "provider_not_found",
      "One or more providers do not exist."
    );
  }
  const mismatched = rows.find(
    (row) => row.providerType !== input.providerType || row.priority !== input.priority
  );
  if (mismatched) {
    throw new ProviderWeightAdjustmentError(
      "provider_scope_mismatch",
      `Provider ${mismatched.providerId} does not match the rule type and priority.`
    );
  }

  const membershipConditions = [
    inArray(providerWeightAdjustmentRuleMembers.providerId, providerIds),
  ];
  if (input.ruleId !== undefined) {
    membershipConditions.push(ne(providerWeightAdjustmentRuleMembers.ruleId, input.ruleId));
  }
  const [conflict] = await executor
    .select({ providerId: providerWeightAdjustmentRuleMembers.providerId })
    .from(providerWeightAdjustmentRuleMembers)
    .where(and(...membershipConditions))
    .limit(1);
  if (conflict) {
    throw new ProviderWeightAdjustmentError(
      "provider_already_managed",
      `Provider ${conflict.providerId} already belongs to another rule.`
    );
  }

  const byId = new Map(rows.map((row) => [row.providerId, row]));
  return providerIds.map((id) => byId.get(id)!);
}

export interface CreateProviderWeightAdjustmentRuleInput {
  name: string;
  description?: string | null;
  providerType: ProviderType;
  priority: number;
  providerIds: number[];
  isEnabled?: boolean;
  now?: Date;
}

export async function createProviderWeightAdjustmentRule(
  input: CreateProviderWeightAdjustmentRuleInput
): Promise<ProviderWeightAdjustmentRule> {
  return db.transaction(async (tx) => {
    const members = await validateMemberIds(tx, input);
    const preview = calculateProviderWeightAdjustment(
      { providerType: input.providerType, priority: input.priority },
      members
    );
    const shouldEnable = input.isEnabled ?? preview.actionable;
    if (shouldEnable && !preview.actionable) {
      throw new ProviderWeightAdjustmentError(
        "insufficient_participants",
        "At least two valid participants are required to enable a rule."
      );
    }

    const [settings] = await tx
      .select({ interval: systemSettings.providerWeightAdjustmentIntervalMinutes })
      .from(systemSettings)
      .limit(1);
    const now = input.now ?? new Date();
    const interval = settings?.interval ?? 30;
    const [created] = await tx
      .insert(providerWeightAdjustmentRules)
      .values({
        name: input.name.trim(),
        description: input.description?.trim() || null,
        providerType: input.providerType,
        priority: input.priority,
        isEnabled: shouldEnable,
        nextRunAt: shouldEnable ? new Date(now.getTime() + interval * 60_000) : null,
      })
      .returning();

    if (members.length > 0) {
      await tx.insert(providerWeightAdjustmentRuleMembers).values(
        members.map((member) => ({
          ruleId: created.id,
          providerId: member.providerId,
        }))
      );
    }
    return toRule(created);
  });
}

export interface UpdateProviderWeightAdjustmentRuleInput {
  name?: string;
  description?: string | null;
  providerType?: ProviderType;
  priority?: number;
}

export async function updateProviderWeightAdjustmentRule(
  ruleId: number,
  input: UpdateProviderWeightAdjustmentRuleInput
): Promise<ProviderWeightAdjustmentRule> {
  return db.transaction(async (tx) => {
    const rule = await selectRule(tx, ruleId);
    if (!rule) {
      throw new ProviderWeightAdjustmentError("rule_not_found", "Rule not found.");
    }
    const scopeChanged =
      (input.providerType !== undefined && input.providerType !== rule.providerType) ||
      (input.priority !== undefined && input.priority !== rule.priority);
    if (scopeChanged) {
      const [member] = await tx
        .select({ id: providerWeightAdjustmentRuleMembers.id })
        .from(providerWeightAdjustmentRuleMembers)
        .where(eq(providerWeightAdjustmentRuleMembers.ruleId, ruleId))
        .limit(1);
      if (member) {
        throw new ProviderWeightAdjustmentError(
          "scope_locked_by_members",
          "Remove all members before changing the rule type or priority."
        );
      }
    }

    const [updated] = await tx
      .update(providerWeightAdjustmentRules)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined
          ? { description: input.description?.trim() || null }
          : {}),
        ...(input.providerType !== undefined ? { providerType: input.providerType } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        revision: sql`${providerWeightAdjustmentRules.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerWeightAdjustmentRules.id, ruleId),
          isNull(providerWeightAdjustmentRules.deletedAt)
        )
      )
      .returning();
    return toRule(updated);
  });
}

export async function replaceProviderWeightAdjustmentRuleMembers(
  ruleId: number,
  providerIds: number[]
): Promise<WeightAdjustmentPreview> {
  return db.transaction(async (tx) => {
    const rule = await selectRule(tx, ruleId);
    if (!rule) {
      throw new ProviderWeightAdjustmentError("rule_not_found", "Rule not found.");
    }
    const members = await validateMemberIds(tx, {
      ruleId,
      providerType: rule.providerType,
      priority: rule.priority,
      providerIds,
    });
    await tx
      .delete(providerWeightAdjustmentRuleMembers)
      .where(eq(providerWeightAdjustmentRuleMembers.ruleId, ruleId));
    if (members.length > 0) {
      await tx
        .insert(providerWeightAdjustmentRuleMembers)
        .values(members.map((member) => ({ ruleId, providerId: member.providerId })));
    }
    await tx
      .update(providerWeightAdjustmentRules)
      .set({
        revision: sql`${providerWeightAdjustmentRules.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(providerWeightAdjustmentRules.id, ruleId));

    return calculateProviderWeightAdjustment(
      { providerType: rule.providerType, priority: rule.priority },
      members
    );
  });
}

export async function setProviderWeightAdjustmentRuleEnabled(
  ruleId: number,
  enabled: boolean,
  now = new Date()
): Promise<ProviderWeightAdjustmentRule> {
  return db.transaction(async (tx) => {
    const rule = await selectRule(tx, ruleId);
    if (!rule) {
      throw new ProviderWeightAdjustmentError("rule_not_found", "Rule not found.");
    }
    if (enabled) {
      const members = await loadMemberInputs(tx, ruleId);
      const preview = calculateProviderWeightAdjustment(
        { providerType: rule.providerType, priority: rule.priority },
        members
      );
      if (!preview.actionable) {
        throw new ProviderWeightAdjustmentError(
          "insufficient_participants",
          "At least two valid participants are required to enable a rule."
        );
      }
    }
    const [settings] = await tx
      .select({ interval: systemSettings.providerWeightAdjustmentIntervalMinutes })
      .from(systemSettings)
      .limit(1);
    const [updated] = await tx
      .update(providerWeightAdjustmentRules)
      .set({
        isEnabled: enabled,
        nextRunAt: enabled ? new Date(now.getTime() + (settings?.interval ?? 30) * 60_000) : null,
        revision: sql`${providerWeightAdjustmentRules.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(providerWeightAdjustmentRules.id, ruleId),
          isNull(providerWeightAdjustmentRules.deletedAt)
        )
      )
      .returning();
    return toRule(updated);
  });
}

export async function setAllProviderWeightAdjustmentRulesEnabled(
  enabled: boolean,
  now = new Date()
): Promise<{ enabledRuleIds: number[]; rejected: Array<{ ruleId: number; code: string }> }> {
  const rules = await listProviderWeightAdjustmentRules();
  const enabledRuleIds: number[] = [];
  const rejected: Array<{ ruleId: number; code: string }> = [];
  for (const rule of rules) {
    try {
      await setProviderWeightAdjustmentRuleEnabled(rule.id, enabled, now);
      enabledRuleIds.push(rule.id);
    } catch (error) {
      rejected.push({
        ruleId: rule.id,
        code: error instanceof ProviderWeightAdjustmentError ? error.code : "rule_update_failed",
      });
    }
  }
  return { enabledRuleIds, rejected };
}

export async function deleteProviderWeightAdjustmentRule(ruleId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const rule = await selectRule(tx, ruleId);
    if (!rule) {
      throw new ProviderWeightAdjustmentError("rule_not_found", "Rule not found.");
    }
    if (rule.activeRunId !== null) {
      throw new ProviderWeightAdjustmentError(
        "rule_has_active_run",
        "A rule with an active run cannot be deleted."
      );
    }
    const now = new Date();
    await tx
      .delete(providerWeightAdjustmentRuleMembers)
      .where(eq(providerWeightAdjustmentRuleMembers.ruleId, ruleId));
    await tx
      .update(providerWeightAdjustmentRules)
      .set({ isEnabled: false, nextRunAt: null, deletedAt: now, updatedAt: now })
      .where(eq(providerWeightAdjustmentRules.id, ruleId));
  });
}

export interface ProviderWeightAdjustmentMembershipInfo {
  ruleId: number;
  ruleName: string;
  ruleEnabled: boolean;
}

export async function getProviderWeightAdjustmentMembership(
  providerId: number
): Promise<ProviderWeightAdjustmentMembershipInfo | null> {
  const [row] = await db
    .select({
      ruleId: providerWeightAdjustmentRules.id,
      ruleName: providerWeightAdjustmentRules.name,
      ruleEnabled: providerWeightAdjustmentRules.isEnabled,
    })
    .from(providerWeightAdjustmentRuleMembers)
    .innerJoin(
      providerWeightAdjustmentRules,
      eq(providerWeightAdjustmentRuleMembers.ruleId, providerWeightAdjustmentRules.id)
    )
    .where(
      and(
        eq(providerWeightAdjustmentRuleMembers.providerId, providerId),
        isNull(providerWeightAdjustmentRules.deletedAt)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function listProviderWeightAdjustmentMemberships(
  providerIds: number[]
): Promise<Array<ProviderWeightAdjustmentMembershipInfo & { providerId: number }>> {
  if (providerIds.length === 0) return [];
  return db
    .select({
      providerId: providerWeightAdjustmentRuleMembers.providerId,
      ruleId: providerWeightAdjustmentRules.id,
      ruleName: providerWeightAdjustmentRules.name,
      ruleEnabled: providerWeightAdjustmentRules.isEnabled,
    })
    .from(providerWeightAdjustmentRuleMembers)
    .innerJoin(
      providerWeightAdjustmentRules,
      eq(providerWeightAdjustmentRuleMembers.ruleId, providerWeightAdjustmentRules.id)
    )
    .where(
      and(
        inArray(providerWeightAdjustmentRuleMembers.providerId, providerIds),
        isNull(providerWeightAdjustmentRules.deletedAt)
      )
    );
}

export async function detachProviderFromWeightAdjustmentRule(
  providerId: number,
  executor: MutationExecutor = db,
  expectedRuleId?: number
): Promise<ProviderWeightAdjustmentMembershipInfo | null> {
  const [membership] = await executor
    .select({
      memberId: providerWeightAdjustmentRuleMembers.id,
      ruleId: providerWeightAdjustmentRules.id,
      ruleName: providerWeightAdjustmentRules.name,
      ruleEnabled: providerWeightAdjustmentRules.isEnabled,
    })
    .from(providerWeightAdjustmentRuleMembers)
    .innerJoin(
      providerWeightAdjustmentRules,
      eq(providerWeightAdjustmentRuleMembers.ruleId, providerWeightAdjustmentRules.id)
    )
    .where(
      and(
        eq(providerWeightAdjustmentRuleMembers.providerId, providerId),
        ...(expectedRuleId === undefined
          ? []
          : [eq(providerWeightAdjustmentRuleMembers.ruleId, expectedRuleId)]),
        isNull(providerWeightAdjustmentRules.deletedAt)
      )
    )
    .limit(1);
  if (!membership) return null;

  await executor
    .delete(providerWeightAdjustmentRuleMembers)
    .where(eq(providerWeightAdjustmentRuleMembers.id, membership.memberId));
  await executor
    .update(providerWeightAdjustmentRules)
    .set({
      revision: sql`${providerWeightAdjustmentRules.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(providerWeightAdjustmentRules.id, membership.ruleId));
  return membership;
}

export async function getProviderWeightAdjustmentInterval(): Promise<number> {
  const [settings] = await db
    .select({ interval: systemSettings.providerWeightAdjustmentIntervalMinutes })
    .from(systemSettings)
    .limit(1);
  return settings?.interval ?? 30;
}

export async function setProviderWeightAdjustmentInterval(
  interval: ProviderWeightAdjustmentIntervalMinutes,
  now = new Date()
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(systemSettings)
      .set({ providerWeightAdjustmentIntervalMinutes: interval, updatedAt: now });
    await tx
      .update(providerWeightAdjustmentRules)
      .set({
        nextRunAt: new Date(now.getTime() + interval * 60_000),
        revision: sql`${providerWeightAdjustmentRules.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          isNull(providerWeightAdjustmentRules.deletedAt),
          eq(providerWeightAdjustmentRules.isEnabled, true)
        )
      );
  });
}

export async function postponeDueProviderWeightAdjustmentRule(
  ruleId: number,
  now = new Date()
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [settings] = await tx
      .select({ interval: systemSettings.providerWeightAdjustmentIntervalMinutes })
      .from(systemSettings)
      .limit(1);
    const updated = await tx
      .update(providerWeightAdjustmentRules)
      .set({
        nextRunAt: new Date(now.getTime() + (settings?.interval ?? 30) * 60_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(providerWeightAdjustmentRules.id, ruleId),
          eq(providerWeightAdjustmentRules.isEnabled, true),
          lte(providerWeightAdjustmentRules.nextRunAt, now),
          isNull(providerWeightAdjustmentRules.deletedAt)
        )
      )
      .returning({ id: providerWeightAdjustmentRules.id });
    return updated.length === 1;
  });
}

export async function initializeProviderWeightAdjustmentSchedule(now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const [settings] = await tx
      .select({ interval: systemSettings.providerWeightAdjustmentIntervalMinutes })
      .from(systemSettings)
      .limit(1);
    await tx
      .update(providerWeightAdjustmentRules)
      .set({
        nextRunAt: new Date(now.getTime() + (settings?.interval ?? 30) * 60_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(providerWeightAdjustmentRules.isEnabled, true),
          isNull(providerWeightAdjustmentRules.deletedAt),
          sql`(${providerWeightAdjustmentRules.nextRunAt} IS NULL OR ${providerWeightAdjustmentRules.nextRunAt} <= ${now})`
        )
      );
  });
}

export interface ClaimProviderWeightAdjustmentRunInput {
  ruleId: number;
  trigger: ProviderWeightAdjustmentTrigger;
  idempotencyKey?: string | null;
  requestedAt?: Date;
}

export async function claimProviderWeightAdjustmentRun(
  input: ClaimProviderWeightAdjustmentRunInput
): Promise<{
  run: ProviderWeightAdjustmentRun;
  rule: ProviderWeightAdjustmentRule;
  replay: boolean;
}> {
  return db.transaction(async (tx) => {
    if (input.idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(providerWeightAdjustmentRuns)
        .where(
          and(
            eq(providerWeightAdjustmentRuns.ruleId, input.ruleId),
            eq(providerWeightAdjustmentRuns.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (existing) {
        const rule = await selectRule(tx, input.ruleId);
        if (!rule) {
          throw new ProviderWeightAdjustmentError("rule_not_found", "Rule not found.");
        }
        return { run: toRun(existing), rule, replay: true };
      }
    }

    const rule = await selectRule(tx, input.ruleId);
    if (!rule) {
      throw new ProviderWeightAdjustmentError("rule_not_found", "Rule not found.");
    }
    if (rule.activeRunId !== null) {
      throw new ProviderWeightAdjustmentError("run_overlap", "The rule is already running.");
    }
    const now = input.requestedAt ?? new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
    const [created] = await tx
      .insert(providerWeightAdjustmentRuns)
      .values({
        ruleId: rule.id,
        trigger: input.trigger,
        status: "running",
        idempotencyKey: input.idempotencyKey ?? null,
        ruleName: rule.name,
        providerType: rule.providerType,
        priority: rule.priority,
        ruleRevision: rule.revision,
        summary: EMPTY_SUMMARY,
        startedAt: now,
        expiresAt,
      })
      .returning();

    const [settings] = await tx
      .select({ interval: systemSettings.providerWeightAdjustmentIntervalMinutes })
      .from(systemSettings)
      .limit(1);
    const [claimed] = await tx
      .update(providerWeightAdjustmentRules)
      .set({
        activeRunId: created.id,
        ...(rule.isEnabled
          ? { nextRunAt: new Date(now.getTime() + (settings?.interval ?? 30) * 60_000) }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(providerWeightAdjustmentRules.id, rule.id),
          isNull(providerWeightAdjustmentRules.activeRunId),
          isNull(providerWeightAdjustmentRules.deletedAt)
        )
      )
      .returning();
    if (!claimed) {
      throw new ProviderWeightAdjustmentError("run_overlap", "The rule is already running.");
    }
    return { run: toRun(created), rule: toRule(claimed), replay: false };
  });
}

export async function loadProviderWeightAdjustmentRunSnapshot(ruleId: number): Promise<{
  rule: ProviderWeightAdjustmentRule;
  members: WeightAdjustmentMemberInput[];
} | null> {
  const rule = await selectRule(db, ruleId);
  if (!rule) return null;
  return { rule, members: await loadMemberInputs(db, ruleId) };
}

export interface CompleteProviderWeightAdjustmentRunInput {
  runId: number;
  ruleId: number;
  expectedRevision: number;
  status: Exclude<ProviderWeightAdjustmentRunStatus, "running">;
  summary: ProviderWeightAdjustmentRunSummary;
  details: Array<{
    providerId: number;
    providerName: string;
    outcome: ProviderWeightAdjustmentDetailOutcome;
    costMultiplier: number | null;
    previousWeight: number;
    projectedWeight: number | null;
    reason?: string | null;
  }>;
  changes: Array<{
    providerId: number;
    previousWeight: number;
    nextWeight: number;
    costMultiplier: number;
    providerType: ProviderType;
    priority: number;
    isEnabled: boolean;
  }>;
  errorMessage?: string | null;
  completedAt?: Date;
}

export async function completeProviderWeightAdjustmentRun(
  input: CompleteProviderWeightAdjustmentRunInput
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const change of input.changes) {
      const updated = await tx
        .update(providers)
        .set({ weight: change.nextWeight, updatedAt: input.completedAt ?? new Date() })
        .where(
          and(
            eq(providers.id, change.providerId),
            eq(providers.weight, change.previousWeight),
            eq(providers.costMultiplier, String(change.costMultiplier)),
            eq(providers.providerType, change.providerType),
            eq(providers.priority, change.priority),
            eq(providers.isEnabled, change.isEnabled),
            isNull(providers.deletedAt)
          )
        )
        .returning({ id: providers.id });
      if (updated.length !== 1) {
        throw new ProviderWeightAdjustmentError(
          "provider_changed",
          `Provider ${change.providerId} changed while the rule was running.`
        );
      }
    }

    const completedAt = input.completedAt ?? new Date();
    const [rule] = await tx
      .update(providerWeightAdjustmentRules)
      .set({ activeRunId: null, lastRunAt: completedAt, updatedAt: completedAt })
      .where(
        and(
          eq(providerWeightAdjustmentRules.id, input.ruleId),
          eq(providerWeightAdjustmentRules.revision, input.expectedRevision),
          eq(providerWeightAdjustmentRules.activeRunId, input.runId),
          isNull(providerWeightAdjustmentRules.deletedAt)
        )
      )
      .returning({ id: providerWeightAdjustmentRules.id });
    if (!rule) {
      throw new ProviderWeightAdjustmentError(
        "rule_changed",
        "The rule changed while the run was executing."
      );
    }

    await tx
      .update(providerWeightAdjustmentRuns)
      .set({
        status: input.status,
        summary: input.summary,
        errorMessage: input.errorMessage ?? null,
        completedAt,
      })
      .where(eq(providerWeightAdjustmentRuns.id, input.runId));
    if (input.details.length > 0) {
      await tx.insert(providerWeightAdjustmentRunDetails).values(
        input.details.map((detail) => ({
          ...detail,
          runId: input.runId,
          costMultiplier: detail.costMultiplier === null ? null : String(detail.costMultiplier),
        }))
      );
    }
  });
}

export async function failProviderWeightAdjustmentRun(
  runId: number,
  ruleId: number,
  message: string,
  completedAt = new Date(),
  details: CompleteProviderWeightAdjustmentRunInput["details"] = [],
  summary?: ProviderWeightAdjustmentRunSummary
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(providerWeightAdjustmentRuns)
      .set({
        status: "failed",
        errorMessage: message,
        completedAt,
        ...(summary ? { summary } : {}),
      })
      .where(eq(providerWeightAdjustmentRuns.id, runId));
    await tx
      .update(providerWeightAdjustmentRules)
      .set({ activeRunId: null, lastRunAt: completedAt, updatedAt: completedAt })
      .where(
        and(
          eq(providerWeightAdjustmentRules.id, ruleId),
          eq(providerWeightAdjustmentRules.activeRunId, runId)
        )
      );
    if (details.length > 0) {
      await tx.insert(providerWeightAdjustmentRunDetails).values(
        details.map((detail) => ({
          ...detail,
          runId,
          outcome: "failed",
          costMultiplier: detail.costMultiplier === null ? null : String(detail.costMultiplier),
        }))
      );
    }
  });
}

export async function markProviderWeightAdjustmentRunWarning(
  runId: number,
  message: string
): Promise<void> {
  await db
    .update(providerWeightAdjustmentRuns)
    .set({ status: "succeeded_with_warning", errorMessage: message })
    .where(eq(providerWeightAdjustmentRuns.id, runId));
}

export async function findProviderWeightAdjustmentRunByIdempotencyKey(
  ruleId: number,
  idempotencyKey: string
): Promise<ProviderWeightAdjustmentRun | null> {
  const [row] = await db
    .select()
    .from(providerWeightAdjustmentRuns)
    .where(
      and(
        eq(providerWeightAdjustmentRuns.ruleId, ruleId),
        eq(providerWeightAdjustmentRuns.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  return row ? toRun(row) : null;
}

export async function setProviderWeightAdjustmentFault(
  ruleId: number,
  fault: { kind: ProviderWeightAdjustmentFaultKind; message: string; now?: Date }
): Promise<boolean> {
  const now = fault.now ?? new Date();
  const updated = await db
    .update(providerWeightAdjustmentRules)
    .set({
      faultActive: true,
      faultKind: fault.kind,
      faultMessage: fault.message,
      faultStartedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerWeightAdjustmentRules.id, ruleId),
        eq(providerWeightAdjustmentRules.faultActive, false),
        isNull(providerWeightAdjustmentRules.deletedAt)
      )
    )
    .returning({ id: providerWeightAdjustmentRules.id });
  return updated.length === 1;
}

export async function clearProviderWeightAdjustmentFault(ruleId: number): Promise<boolean> {
  const updated = await db
    .update(providerWeightAdjustmentRules)
    .set({
      faultActive: false,
      faultKind: null,
      faultMessage: null,
      faultStartedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(providerWeightAdjustmentRules.id, ruleId),
        eq(providerWeightAdjustmentRules.faultActive, true),
        isNull(providerWeightAdjustmentRules.deletedAt)
      )
    )
    .returning({ id: providerWeightAdjustmentRules.id });
  return updated.length === 1;
}

export async function getProviderWeightAdjustmentRun(
  runId: number
): Promise<ProviderWeightAdjustmentRun | null> {
  const [row] = await db
    .select()
    .from(providerWeightAdjustmentRuns)
    .where(eq(providerWeightAdjustmentRuns.id, runId))
    .limit(1);
  return row ? toRun(row) : null;
}

export async function listProviderWeightAdjustmentRuns(
  ruleId: number,
  limit = 50
): Promise<ProviderWeightAdjustmentRun[]> {
  const rows = await db
    .select()
    .from(providerWeightAdjustmentRuns)
    .where(eq(providerWeightAdjustmentRuns.ruleId, ruleId))
    .orderBy(desc(providerWeightAdjustmentRuns.startedAt))
    .limit(Math.min(200, Math.max(1, limit)));
  return rows.map(toRun);
}

export async function listProviderWeightAdjustmentRunDetails(
  runId: number
): Promise<ProviderWeightAdjustmentRunDetail[]> {
  const rows = await db
    .select()
    .from(providerWeightAdjustmentRunDetails)
    .where(eq(providerWeightAdjustmentRunDetails.runId, runId))
    .orderBy(asc(providerWeightAdjustmentRunDetails.id));
  return rows.map(toRunDetail);
}

export async function cleanupExpiredProviderWeightAdjustmentRuns(
  now = new Date()
): Promise<number> {
  const deleted = await db
    .delete(providerWeightAdjustmentRuns)
    .where(lte(providerWeightAdjustmentRuns.expiresAt, now))
    .returning({ id: providerWeightAdjustmentRuns.id });
  return deleted.length;
}
