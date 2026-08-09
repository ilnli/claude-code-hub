"use client";

import {
  AlertTriangle,
  Check,
  Code2,
  Eye,
  HelpCircle,
  Package,
  Plus,
  Save,
  ShieldOff,
  Tag,
  Terminal,
  Trash2,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  bulkCreateAutomaticClientVersionPolicies,
  createClientVersionPolicy,
  deleteClientVersionPolicy,
  overrideClientVersionPolicy,
  updateClientVersionPolicy,
} from "@/lib/api-client/v1/actions/client-version-policies";
import type { ClientVersionStats } from "@/lib/client-version-checker";
import { buildFixedPolicyOverride, normalizeClientVersion } from "@/lib/client-version-policy";
import { getClientTypeDisplayName } from "@/lib/ua-parser";
import { formatDateDistance } from "@/lib/utils/date-format";
import type {
  ClientVersionPolicyMode,
  ClientVersionPolicyWrite,
  ClientVersionStatus,
} from "@/types/client-version-policy";

interface ClientVersionStatsTableProps {
  data: ClientVersionStats[];
  globalEnabled: boolean;
}

const MODES: ClientVersionPolicyMode[] = [
  "automatic_baseline",
  "minimum",
  "maximum",
  "range",
  "baseline_lag",
];

function getClientTypeIcon(clientType: string): React.ComponentType<{ className?: string }> {
  const icons: Record<string, React.ComponentType<{ className?: string }>> = {
    "claude-vscode": Code2,
    "claude-cli": Terminal,
    "claude-cli-unknown": HelpCircle,
    "anthropic-sdk-typescript": Package,
  };
  return icons[clientType] || HelpCircle;
}

export function ClientVersionStatsTable({ data, globalEnabled }: ClientVersionStatsTableProps) {
  const t = useTranslations("settings.clientVersions");
  const router = useRouter();
  const [isBulkPending, startBulkTransition] = useTransition();
  const configuredCount = data.filter((item) => item.policy).length;
  const unconfiguredCount = data.length - configuredCount;
  const totalUsers = data.reduce((sum, item) => sum + item.totalUsers, 0);
  const outOfRangeCount = data.reduce(
    (sum, item) =>
      sum +
      item.users.filter(
        (user) => user.status === "below_minimum" || user.status === "above_maximum"
      ).length,
    0
  );

  function createAllAutomatic() {
    startBulkTransition(async () => {
      const result = await bulkCreateAutomaticClientVersionPolicies();
      if (!result.ok) {
        toast.error(t("actions.failed"));
        return;
      }
      toast.success(t("actions.bulkCreated", { count: result.data.createdCount }));
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant={globalEnabled ? "default" : "outline"} className="h-7 gap-1.5">
            {globalEnabled ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <ShieldOff className="h-3.5 w-3.5" />
            )}
            {globalEnabled ? t("state.active") : t("state.paused")}
          </Badge>
          {!globalEnabled && (
            <span className="text-xs text-muted-foreground">{t("state.preview")}</span>
          )}
        </div>
        {unconfiguredCount > 0 && (
          <Button variant="outline" size="sm" onClick={createAllAutomatic} disabled={isBulkPending}>
            <Plus className="h-4 w-4" />
            {t("actions.createAll", { count: unconfiguredCount })}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric icon={Package} label={t("metrics.clientTypes")} value={data.length} />
        <Metric icon={Users} label={t("metrics.totalUsers")} value={totalUsers} />
        <Metric icon={Tag} label={t("metrics.configured")} value={configuredCount} />
        <Metric icon={AlertTriangle} label={t("metrics.outOfRange")} value={outOfRangeCount} />
      </div>

      <div className="space-y-4">
        {data.map((clientStats) => (
          <ClientTypeSection
            key={clientStats.clientType}
            stats={clientStats}
            globalEnabled={globalEnabled}
          />
        ))}
      </div>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 p-3">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>
      <p className="font-mono text-lg font-semibold">{value}</p>
    </div>
  );
}

function ClientTypeSection({
  stats,
  globalEnabled,
}: {
  stats: ClientVersionStats;
  globalEnabled: boolean;
}) {
  const t = useTranslations("settings.clientVersions");
  const locale = useLocale();
  const Icon = getClientTypeIcon(stats.clientType);
  const range = formatRange(
    stats.effectiveMinimumVersion,
    stats.effectiveMaximumVersion,
    t("range.any")
  );

  return (
    <section className="overflow-hidden rounded-md border border-border/60 bg-muted/10">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="shrink-0 rounded-md bg-orange-500/10 p-2 text-orange-500">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">
              {getClientTypeDisplayName(stats.clientType)}
            </h3>
            <code className="text-[11px] text-muted-foreground">{stats.clientType}</code>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {stats.policy ? t(`modes.${stats.policy.mode}`) : t("state.unconfigured")}
          </Badge>
          <Badge variant="secondary" className="font-mono">
            {range}
          </Badge>
          <Badge variant="outline">{t("table.usersCount", { count: stats.totalUsers })}</Badge>
        </div>
      </div>

      <PolicyEditor stats={stats} />

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t("table.user")}</TableHead>
            <TableHead>{t("table.version")}</TableHead>
            <TableHead>{t("table.lastActive")}</TableHead>
            <TableHead>{t("table.status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats.users.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                {t("table.noUsers")}
              </TableCell>
            </TableRow>
          ) : (
            stats.users.map((user) => (
              <TableRow key={`${user.userId}-${user.version}`}>
                <TableCell className="font-medium">{user.username}</TableCell>
                <TableCell>
                  <code className="rounded bg-muted/60 px-2 py-1 text-xs">{user.version}</code>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDateDistance(new Date(user.lastSeen), new Date(), locale)}
                </TableCell>
                <TableCell>
                  <StatusBadge
                    status={user.status}
                    preview={!globalEnabled && stats.policy !== null}
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}

function PolicyEditor({ stats }: { stats: ClientVersionStats }) {
  const t = useTranslations("settings.clientVersions");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [mode, setMode] = useState<ClientVersionPolicyMode>(
    stats.policy?.mode ?? "automatic_baseline"
  );
  const [minimumVersion, setMinimumVersion] = useState(stats.policy?.minimumVersion ?? "");
  const [maximumVersion, setMaximumVersion] = useState(stats.policy?.maximumVersion ?? "");
  const [baselineLag, setBaselineLag] = useState(String(stats.policy?.baselineLag ?? 1));
  const [previousSeries, setPreviousSeries] = useState(
    stats.policy?.previousSeriesTerminalVersion ?? ""
  );
  const [overrideVersion, setOverrideVersion] = useState(stats.automaticBaseline ?? "");

  useEffect(() => {
    setMode(stats.policy?.mode ?? "automatic_baseline");
    setMinimumVersion(stats.policy?.minimumVersion ?? "");
    setMaximumVersion(stats.policy?.maximumVersion ?? "");
    setBaselineLag(String(stats.policy?.baselineLag ?? 1));
    setPreviousSeries(stats.policy?.previousSeriesTerminalVersion ?? "");
    setOverrideVersion(stats.automaticBaseline ?? "");
  }, [stats]);

  const suggestions = useMemo(
    () =>
      Array.from(
        new Set(stats.users.map((user) => normalizeClientVersion(user.version)).filter(Boolean))
      ) as string[],
    [stats.users]
  );
  const overridePreview =
    stats.policy && overrideVersion
      ? buildFixedPolicyOverride(stats.policy, overrideVersion)
      : null;

  function save() {
    const policy = buildWrite();
    if (!policy) {
      toast.error(t("validation.invalid"));
      return;
    }
    startTransition(async () => {
      const result = stats.policy
        ? await updateClientVersionPolicy(stats.clientType, policy)
        : await createClientVersionPolicy(stats.clientType, policy);
      if (!result.ok) {
        toast.error(t("actions.failed"));
        return;
      }
      toast.success(t(stats.policy ? "actions.updated" : "actions.created"));
      router.refresh();
    });
  }

  function applyOverride() {
    if (!overridePreview) {
      toast.error(t("validation.invalid"));
      return;
    }
    startTransition(async () => {
      const result = await overrideClientVersionPolicy(stats.clientType, overrideVersion);
      if (!result.ok) {
        toast.error(t("actions.failed"));
        return;
      }
      toast.success(t("actions.updated"));
      router.refresh();
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteClientVersionPolicy(stats.clientType);
      if (!result.ok) {
        toast.error(t("actions.failed"));
        return;
      }
      toast.success(t("actions.deleted"));
      router.refresh();
    });
  }

  function buildWrite(): ClientVersionPolicyWrite | null {
    switch (mode) {
      case "automatic_baseline":
        return { mode };
      case "minimum":
        return minimumVersion ? { mode, minimumVersion } : null;
      case "maximum":
        return maximumVersion ? { mode, maximumVersion } : null;
      case "range":
        return minimumVersion && maximumVersion ? { mode, minimumVersion, maximumVersion } : null;
      case "baseline_lag": {
        const lag = Number.parseInt(baselineLag, 10);
        return Number.isSafeInteger(lag) && lag > 0
          ? {
              mode,
              baselineLag: lag,
              previousSeriesTerminalVersion: previousSeries || null,
            }
          : null;
      }
    }
  }

  return (
    <div className="space-y-3 border-b border-border/50 bg-background/40 px-4 py-3">
      <datalist id={`versions-${stats.clientType}`}>
        {suggestions.map((version) => (
          <option key={version} value={version} />
        ))}
      </datalist>
      <div className="grid gap-3 md:grid-cols-[minmax(180px,0.8fr)_minmax(0,2fr)_auto] md:items-end">
        <Field label={t("editor.mode")}>
          <Select value={mode} onValueChange={(value) => setMode(value as ClientVersionPolicyMode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((item) => (
                <SelectItem key={item} value={item}>
                  {t(`modes.${item}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          {(mode === "minimum" || mode === "range") && (
            <VersionField
              label={t("editor.minimum")}
              value={minimumVersion}
              onChange={setMinimumVersion}
              listId={`versions-${stats.clientType}`}
            />
          )}
          {(mode === "maximum" || mode === "range") && (
            <VersionField
              label={t("editor.maximum")}
              value={maximumVersion}
              onChange={setMaximumVersion}
              listId={`versions-${stats.clientType}`}
            />
          )}
          {mode === "automatic_baseline" && (
            <ReadValue
              label={t("editor.automaticBaseline")}
              value={stats.automaticBaseline ?? t("state.waitingForBaseline")}
            />
          )}
          {mode === "baseline_lag" && (
            <>
              <Field label={t("editor.lag")}>
                <Input
                  inputMode="numeric"
                  type="number"
                  min={1}
                  step={1}
                  value={baselineLag}
                  onChange={(event) => setBaselineLag(event.target.value)}
                />
              </Field>
              <VersionField
                label={t("editor.previousSeries")}
                value={previousSeries}
                onChange={setPreviousSeries}
                listId={`versions-${stats.clientType}`}
                disabled={!stats.automaticBaseline}
              />
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button size="icon" onClick={save} disabled={isPending} title={t("actions.save")}>
            <Save className="h-4 w-4" />
          </Button>
          {stats.policy && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="icon"
                  variant="outline"
                  disabled={isPending}
                  title={t("actions.delete")}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("deleteDialog.description", { clientType: stats.clientType })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("deleteDialog.cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={remove}>
                    {t("deleteDialog.confirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {stats.policy &&
        (stats.policy.mode === "automatic_baseline" || stats.policy.mode === "baseline_lag") && (
          <div className="grid gap-3 border-t border-border/50 pt-3 md:grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)_auto] md:items-end">
            <VersionField
              label={t("editor.overrideVersion")}
              value={overrideVersion}
              onChange={setOverrideVersion}
              listId={`versions-${stats.clientType}`}
            />
            <ReadValue
              label={t("editor.overridePreview")}
              value={
                overridePreview
                  ? formatRange(
                      overridePreview.minimumVersion,
                      overridePreview.maximumVersion,
                      t("range.any")
                    )
                  : t("range.unavailable")
              }
            />
            <Button
              variant="outline"
              onClick={applyOverride}
              disabled={isPending || !overridePreview}
            >
              <Save className="h-4 w-4" />
              {t("actions.applyFixed")}
            </Button>
          </div>
        )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function VersionField({
  label,
  value,
  onChange,
  listId,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  listId: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        list={listId}
        disabled={disabled}
        className="font-mono"
      />
    </Field>
  );
}

function ReadValue({ label, value }: { label: string; value: string }) {
  return (
    <Field label={label}>
      <div className="flex h-9 items-center rounded-md border border-border bg-muted/30 px-3 font-mono text-sm">
        {value}
      </div>
    </Field>
  );
}

function StatusBadge({ status, preview }: { status: ClientVersionStatus; preview: boolean }) {
  const t = useTranslations("settings.clientVersions");
  const config: Record<
    ClientVersionStatus,
    { icon: React.ComponentType<{ className?: string }>; className: string }
  > = {
    below_minimum: { icon: AlertTriangle, className: "border-red-500/30 text-red-500" },
    above_maximum: { icon: AlertTriangle, className: "border-amber-500/30 text-amber-500" },
    within_range: { icon: Check, className: "border-emerald-500/30 text-emerald-500" },
    unparseable: { icon: HelpCircle, className: "text-muted-foreground" },
    unchecked: { icon: ShieldOff, className: "text-muted-foreground" },
  };
  const { icon: Icon, className } = config[status];
  return (
    <Badge variant="outline" className={`gap-1 ${className}`}>
      {preview ? <Eye className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
      {t(`status.${status}`)}
    </Badge>
  );
}

function formatRange(minimum: string | null, maximum: string | null, fallback: string): string {
  if (minimum && maximum) return minimum === maximum ? minimum : `${minimum} - ${maximum}`;
  if (minimum) return `>= ${minimum}`;
  if (maximum) return `<= ${maximum}`;
  return fallback;
}
