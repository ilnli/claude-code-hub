"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, History, Loader2, Pencil, Play, Plus, Scale, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  createWeightAdjustmentRule,
  deleteWeightAdjustmentRule,
  getWeightAdjustmentRules,
  getWeightAdjustmentRuns,
  getWeightAdjustmentSettings,
  replaceWeightAdjustmentRuleMembers,
  runWeightAdjustmentRule,
  setAllWeightAdjustmentRulesEnabled,
  setWeightAdjustmentRuleEnabled,
  updateWeightAdjustmentRule,
  updateWeightAdjustmentSettings,
  type WeightAdjustmentRuleView,
} from "@/lib/api-client/v1/actions/provider-weight-adjustment";
import type { ProviderDisplay, ProviderType } from "@/types/provider";

const PUBLIC_PROVIDER_TYPES = ["claude", "codex", "gemini", "openai-compatible"] as const;
const INTERVALS = [10, 30, 60, 360, 1440] as const;

interface RuleDraft {
  name: string;
  description: string;
  providerType: (typeof PUBLIC_PROVIDER_TYPES)[number];
  priority: number;
  providerIds: number[];
}

const EMPTY_DRAFT: RuleDraft = {
  name: "",
  description: "",
  providerType: "claude",
  priority: 0,
  providerIds: [],
};

function isPublicProviderType(value: string): value is RuleDraft["providerType"] {
  return (PUBLIC_PROVIDER_TYPES as readonly string[]).includes(value);
}

export function WeightAdjustmentRulesDialog({ providers }: { providers: ProviderDisplay[] }) {
  const t = useTranslations("settings.providers.weightAdjustment");
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedRuleId, setSelectedRuleId] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);

  const rulesQuery = useQuery({
    queryKey: ["provider-weight-adjustment-rules"],
    queryFn: getWeightAdjustmentRules,
    enabled: open,
  });
  const settingsQuery = useQuery({
    queryKey: ["provider-weight-adjustment-settings"],
    queryFn: getWeightAdjustmentSettings,
    enabled: open,
  });
  const selectedRule =
    rulesQuery.data?.find((rule) => rule.id === selectedRuleId) ?? rulesQuery.data?.[0] ?? null;
  const historyQuery = useQuery({
    queryKey: ["provider-weight-adjustment-runs", selectedRule?.id],
    queryFn: () => getWeightAdjustmentRuns(selectedRule!.id),
    enabled: open && selectedRule !== null,
  });

  useEffect(() => {
    if (selectedRuleId === null && rulesQuery.data?.[0]) {
      setSelectedRuleId(rulesQuery.data[0].id);
    }
  }, [rulesQuery.data, selectedRuleId]);

  const eligibleProviders = useMemo(
    () =>
      providers
        .filter(
          (provider) =>
            provider.providerType === draft.providerType && provider.priority === draft.priority
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [draft.priority, draft.providerType, providers]
  );

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["provider-weight-adjustment-rules"] }),
      queryClient.invalidateQueries({ queryKey: ["provider-weight-adjustment-runs"] }),
      queryClient.invalidateQueries({ queryKey: ["providers"] }),
    ]);
  };

  const runMutation = async (operation: () => Promise<unknown>, successMessage: string) => {
    setBusy(true);
    try {
      await operation();
      await refresh();
      toast.success(successMessage);
      return true;
    } catch {
      toast.error(t("operationFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const beginCreate = () => {
    setDraft(EMPTY_DRAFT);
    setCreating(true);
    setEditing(true);
  };

  const beginEdit = (rule: WeightAdjustmentRuleView) => {
    if (!isPublicProviderType(rule.providerType)) return;
    setDraft({
      name: rule.name,
      description: rule.description ?? "",
      providerType: rule.providerType,
      priority: rule.priority,
      providerIds: rule.preview.rows.map((row) => row.providerId),
    });
    setCreating(false);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setCreating(false);
  };

  const saveDraft = async () => {
    if (!draft.name.trim()) return;
    const ok = await runMutation(async () => {
      if (creating) {
        const created = await createWeightAdjustmentRule({
          ...draft,
          name: draft.name.trim(),
          description: draft.description.trim() || null,
        });
        setSelectedRuleId(created.id);
      } else if (selectedRule) {
        await updateWeightAdjustmentRule(selectedRule.id, {
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          providerType: draft.providerType,
          priority: draft.priority,
        });
        await replaceWeightAdjustmentRuleMembers(selectedRule.id, draft.providerIds);
      }
    }, t("saved"));
    if (ok) cancelEdit();
  };

  const typeLabel = (providerType: ProviderType) => {
    const key = providerType === "openai-compatible" ? "openaiCompatible" : providerType;
    return t(`providerTypes.${key}`);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Scale className="h-4 w-4" />
          {t("trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-6xl overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2">
            <Scale className="h-5 w-5" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
            <Clock3 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{t("interval")}</span>
            <Select
              value={String(settingsQuery.data?.intervalMinutes ?? 30)}
              onValueChange={(value) => {
                const interval = Number(value);
                void runMutation(async () => {
                  await updateWeightAdjustmentSettings(interval);
                  await queryClient.invalidateQueries({
                    queryKey: ["provider-weight-adjustment-settings"],
                  });
                }, t("intervalSaved"));
              }}
              disabled={busy}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map((interval) => (
                  <SelectItem key={interval} value={String(interval)}>
                    {t(`intervals.${interval}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void runMutation(() => setAllWeightAdjustmentRulesEnabled(true), t("enabledAll"))
                }
              >
                {t("enableAll")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void runMutation(
                    () => setAllWeightAdjustmentRulesEnabled(false),
                    t("disabledAll")
                  )
                }
              >
                {t("disableAll")}
              </Button>
              <Button size="sm" disabled={busy} onClick={beginCreate}>
                <Plus className="h-4 w-4" />
                {t("create")}
              </Button>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 md:grid-cols-[260px_minmax(0,1fr)]">
            <div className="max-h-[68vh] overflow-y-auto border-b p-3 md:border-r md:border-b-0">
              {rulesQuery.isLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : rulesQuery.data?.length ? (
                <div className="space-y-1">
                  {rulesQuery.data.map((rule) => (
                    <button
                      key={rule.id}
                      type="button"
                      className={`w-full border-l-2 px-3 py-2 text-left transition-colors ${
                        selectedRule?.id === rule.id
                          ? "border-primary bg-muted"
                          : "border-transparent hover:bg-muted/60"
                      }`}
                      onClick={() => {
                        setSelectedRuleId(rule.id);
                        cancelEdit();
                      }}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{rule.name}</span>
                        {rule.faultActive ? (
                          <Badge variant="destructive" className="ml-auto shrink-0">
                            {t("fault")}
                          </Badge>
                        ) : (
                          <Badge
                            variant={rule.isEnabled ? "default" : "secondary"}
                            className="ml-auto shrink-0"
                          >
                            {rule.isEnabled ? t("enabled") : t("disabled")}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t("scope", {
                          type: typeLabel(rule.providerType),
                          priority: rule.priority,
                          members: rule.preview.memberCount,
                        })}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="px-3 py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
              )}
            </div>

            <div className="max-h-[68vh] overflow-y-auto p-5">
              {editing ? (
                <div className="space-y-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="weight-rule-name">{t("form.name")}</Label>
                      <Input
                        id="weight-rule-name"
                        value={draft.name}
                        maxLength={128}
                        onChange={(event) =>
                          setDraft((value) => ({ ...value, name: event.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="weight-rule-description">{t("form.description")}</Label>
                      <Input
                        id="weight-rule-description"
                        value={draft.description}
                        maxLength={1000}
                        onChange={(event) =>
                          setDraft((value) => ({ ...value, description: event.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{t("form.providerType")}</Label>
                      <Select
                        value={draft.providerType}
                        disabled={!creating && (selectedRule?.preview.memberCount ?? 0) > 0}
                        onValueChange={(value) => {
                          if (!isPublicProviderType(value)) return;
                          setDraft((draftValue) => ({
                            ...draftValue,
                            providerType: value,
                            providerIds: [],
                          }));
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PUBLIC_PROVIDER_TYPES.map((type) => (
                            <SelectItem key={type} value={type}>
                              {typeLabel(type)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="weight-rule-priority">{t("form.priority")}</Label>
                      <Input
                        id="weight-rule-priority"
                        type="number"
                        value={draft.priority}
                        disabled={!creating && (selectedRule?.preview.memberCount ?? 0) > 0}
                        onChange={(event) =>
                          setDraft((value) => ({
                            ...value,
                            priority: event.target.valueAsNumber || 0,
                            providerIds: [],
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label>{t("form.members")}</Label>
                      <span className="text-xs text-muted-foreground">
                        {t("form.selected", { count: draft.providerIds.length })}
                      </span>
                    </div>
                    <div className="max-h-56 overflow-y-auto border">
                      {eligibleProviders.length ? (
                        eligibleProviders.map((provider) => {
                          const checked = draft.providerIds.includes(provider.id);
                          return (
                            <label
                              key={provider.id}
                              className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-muted/50"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(next) =>
                                  setDraft((value) => ({
                                    ...value,
                                    providerIds: next
                                      ? [...value.providerIds, provider.id]
                                      : value.providerIds.filter((id) => id !== provider.id),
                                  }))
                                }
                              />
                              <span className="min-w-0 flex-1 truncate text-sm">
                                {provider.name}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {t("form.costWeight", {
                                  cost: provider.costMultiplier,
                                  weight: provider.weight,
                                })}
                              </span>
                              {!provider.isEnabled && (
                                <Badge variant="secondary">{t("disabled")}</Badge>
                              )}
                            </label>
                          );
                        })
                      ) : (
                        <p className="p-5 text-center text-sm text-muted-foreground">
                          {t("form.noEligibleProviders")}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={cancelEdit}>
                      {t("cancel")}
                    </Button>
                    <Button disabled={busy || !draft.name.trim()} onClick={() => void saveDraft()}>
                      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                      {t("save")}
                    </Button>
                  </div>
                </div>
              ) : selectedRule ? (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-semibold">{selectedRule.name}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {selectedRule.description || t("noDescription")}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <div className="flex items-center gap-2 rounded-md border px-3">
                        <span className="text-xs text-muted-foreground">{t("enabled")}</span>
                        <Switch
                          checked={selectedRule.isEnabled}
                          disabled={busy}
                          onCheckedChange={(enabled) =>
                            void runMutation(
                              () => setWeightAdjustmentRuleEnabled(selectedRule.id, enabled),
                              enabled ? t("enabledSuccess") : t("disabledSuccess")
                            )
                          }
                        />
                      </div>
                      <Button
                        variant="outline"
                        size="icon"
                        title={t("edit")}
                        onClick={() => beginEdit(selectedRule)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        title={t("runNow")}
                        disabled={busy || selectedRule.activeRunId !== null}
                        onClick={() =>
                          void runMutation(
                            () => runWeightAdjustmentRule(selectedRule.id),
                            t("runComplete")
                          )
                        }
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        title={t("delete")}
                        disabled={busy || selectedRule.activeRunId !== null}
                        onClick={() => {
                          if (!window.confirm(t("deleteConfirm", { name: selectedRule.name })))
                            return;
                          void runMutation(async () => {
                            await deleteWeightAdjustmentRule(selectedRule.id);
                            setSelectedRuleId(null);
                          }, t("deleted"));
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {selectedRule.faultActive && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {t(`faultKinds.${selectedRule.faultKind ?? "scheduler_failed"}`)}
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="grid grid-cols-2 gap-px overflow-hidden border bg-border sm:grid-cols-4">
                    {[
                      [t("summary.members"), selectedRule.preview.memberCount],
                      [t("summary.participants"), selectedRule.preview.participantCount],
                      [t("summary.changes"), selectedRule.preview.changedCount],
                      [
                        t("summary.nextRun"),
                        selectedRule.nextRunAt
                          ? new Date(selectedRule.nextRunAt).toLocaleString()
                          : t("notScheduled"),
                      ],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="bg-background p-3">
                        <div className="text-xs text-muted-foreground">{label}</div>
                        <div className="mt-1 text-sm font-medium">{value}</div>
                      </div>
                    ))}
                  </div>

                  <Tabs defaultValue="preview">
                    <TabsList>
                      <TabsTrigger value="preview">
                        <Scale />
                        {t("preview.title")}
                      </TabsTrigger>
                      <TabsTrigger value="history">
                        <History />
                        {t("history.title")}
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="preview" className="space-y-2">
                      <p className="text-xs text-muted-foreground">{t("preview.shareNote")}</p>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t("preview.provider")}</TableHead>
                            <TableHead>{t("preview.cost")}</TableHead>
                            <TableHead>{t("preview.currentWeight")}</TableHead>
                            <TableHead>{t("preview.projectedWeight")}</TableHead>
                            <TableHead>{t("preview.internalShare")}</TableHead>
                            <TableHead>{t("preview.status")}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedRule.preview.rows.map((row) => (
                            <TableRow key={row.providerId}>
                              <TableCell className="font-medium">{row.providerName}</TableCell>
                              <TableCell>{row.parsedCostMultiplier ?? t("invalid")}</TableCell>
                              <TableCell>{row.currentWeight}</TableCell>
                              <TableCell>{row.projectedWeight ?? "-"}</TableCell>
                              <TableCell>
                                {row.projectedShare === null
                                  ? "-"
                                  : `${(row.projectedShare * 100).toFixed(1)}%`}
                              </TableCell>
                              <TableCell>
                                {row.participates
                                  ? t("preview.participating")
                                  : t(`skipReasons.${row.skipReason}`)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TabsContent>
                    <TabsContent value="history">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t("history.time")}</TableHead>
                            <TableHead>{t("history.trigger")}</TableHead>
                            <TableHead>{t("history.status")}</TableHead>
                            <TableHead>{t("history.changed")}</TableHead>
                            <TableHead>{t("history.skipped")}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(historyQuery.data ?? []).map((run) => (
                            <TableRow key={run.id}>
                              <TableCell>{new Date(run.startedAt).toLocaleString()}</TableCell>
                              <TableCell>{t(`history.triggers.${run.trigger}`)}</TableCell>
                              <TableCell>{t(`history.statuses.${run.status}`)}</TableCell>
                              <TableCell>{run.summary.changedCount}</TableCell>
                              <TableCell>{run.summary.skippedCount}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TabsContent>
                  </Tabs>
                </div>
              ) : (
                <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
                  {t("selectRule")}
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
