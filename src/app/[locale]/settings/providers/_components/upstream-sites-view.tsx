"use client";

import { Check, KeyRound, Loader2, Save, Settings2, TestTube2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type DashboardUpstreamSite,
  useDeleteUpstreamSite,
  useTestUpstreamSitePat,
  useUpdateUpstreamSite,
  useUpstreamSites,
} from "@/lib/api-client/v1/upstream-sites/hooks";

export function UpstreamSitesView() {
  const t = useTranslations("settings.providers.upstreamSites");
  const { data, isLoading, isFetching, isError } = useUpstreamSites();
  const [selectedSite, setSelectedSite] = useState<DashboardUpstreamSite | null>(null);
  const sites = data?.items ?? [];

  if (isLoading) {
    return (
      <div className="flex min-h-40 items-center justify-center" aria-live="polite">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="border px-4 py-8 text-center text-sm text-destructive" role="alert">
        {t("loadFailed")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {isFetching ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("refreshing")}
        </div>
      ) : null}

      <div className="overflow-x-auto border">
        <Table className="min-w-[840px]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("site")}</TableHead>
              <TableHead>{t("providers")}</TableHead>
              <TableHead>{t("newapiProviders")}</TableHead>
              <TableHead>{t("target")}</TableHead>
              <TableHead>{t("pat")}</TableHead>
              <TableHead>{t("uid")}</TableHead>
              <TableHead className="w-14">
                <span className="sr-only">{t("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sites.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-28 text-center text-muted-foreground">
                  {t("empty")}
                </TableCell>
              </TableRow>
            ) : (
              sites.map((site) => (
                <TableRow key={site.id}>
                  <TableCell className="font-mono text-xs">{site.siteKey}</TableCell>
                  <TableCell className="tabular-nums">{site.providerCount}</TableCell>
                  <TableCell className="tabular-nums">{site.newapiProviderCount}</TableCell>
                  <TableCell className="max-w-72 truncate font-mono text-xs">
                    {site.probeBaseUrl ?? t("automaticTarget")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={site.patConfigured ? "default" : "secondary"}>
                      {site.patConfigured ? t("configured") : t("notConfigured")}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {site.dashboardUserId ?? t("notConfigured")}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setSelectedSite(site)}
                      title={t("configure")}
                    >
                      <Settings2 className="h-4 w-4" />
                      <span className="sr-only">{t("configure")}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <UpstreamSiteDialog
        site={selectedSite}
        onOpenChange={(open) => !open && setSelectedSite(null)}
      />
    </div>
  );
}

function UpstreamSiteDialog({
  site,
  onOpenChange,
}: {
  site: DashboardUpstreamSite | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("settings.providers.upstreamSites");
  const updateMutation = useUpdateUpstreamSite();
  const testMutation = useTestUpstreamSitePat();
  const deleteMutation = useDeleteUpstreamSite();
  const [probeBaseUrl, setProbeBaseUrl] = useState("");
  const [dashboardPat, setDashboardPat] = useState("");
  const [dashboardUserId, setDashboardUserId] = useState("");
  const [clearPat, setClearPat] = useState(false);
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyFallbackToDirect, setProxyFallbackToDirect] = useState(false);

  useEffect(() => {
    setProbeBaseUrl(site?.probeBaseUrl ?? "");
    setDashboardPat("");
    setDashboardUserId(site?.dashboardUserId?.toString() ?? "");
    setClearPat(false);
    setAllowInsecureHttp(site?.allowInsecureHttp ?? false);
    setProxyUrl(site?.proxyUrl ?? "");
    setProxyFallbackToDirect(site?.proxyFallbackToDirect ?? false);
  }, [site]);

  const parsedDashboardUserId = useMemo(() => {
    const value = dashboardUserId.trim();
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : null;
  }, [dashboardUserId]);
  const hasEffectivePat = Boolean(!clearPat && (site?.patConfigured || dashboardPat.trim()));
  const credentialsInvalid = hasEffectivePat
    ? parsedDashboardUserId == null
    : dashboardUserId.trim().length > 0;
  const credentialsReady = hasEffectivePat && parsedDashboardUserId != null;

  const input = useMemo(
    () => ({
      probeBaseUrl: probeBaseUrl.trim() || null,
      ...(clearPat
        ? { dashboardPat: null, dashboardUserId: null }
        : dashboardPat.trim()
          ? { dashboardPat: dashboardPat.trim() }
          : {}),
      dashboardUserId: clearPat ? null : parsedDashboardUserId,
      allowInsecureHttp,
      proxyUrl: proxyUrl.trim() || null,
      proxyFallbackToDirect,
    }),
    [
      allowInsecureHttp,
      clearPat,
      dashboardPat,
      parsedDashboardUserId,
      probeBaseUrl,
      proxyFallbackToDirect,
      proxyUrl,
    ]
  );

  if (!site) return null;
  const pending = updateMutation.isPending || testMutation.isPending || deleteMutation.isPending;

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({ siteId: site.id, input });
      toast.success(t("saveSuccess"));
      onOpenChange(false);
    } catch {
      toast.error(t("saveFailed"));
    }
  };

  const handleTest = async () => {
    try {
      const result = await testMutation.mutateAsync({ siteId: site.id, input });
      toast.success(t("testSuccess", { count: result.groupCount }));
    } catch {
      toast.error(t("testFailed"));
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(site.id);
      toast.success(t("deleteSuccess"));
      onOpenChange(false);
    } catch {
      toast.error(t("deleteFailed"));
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{site.siteKey}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-5 py-2">
          <div className="grid gap-2">
            <Label htmlFor={`site-target-${site.id}`}>{t("target")}</Label>
            <Input
              id={`site-target-${site.id}`}
              list={`site-target-candidates-${site.id}`}
              value={probeBaseUrl}
              onChange={(event) => setProbeBaseUrl(event.target.value)}
              disabled={pending}
              placeholder={site.probeTargetCandidates[0] ?? ""}
              spellCheck={false}
            />
            <datalist id={`site-target-candidates-${site.id}`}>
              {site.probeTargetCandidates.map((candidate) => (
                <option key={candidate} value={candidate} />
              ))}
            </datalist>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={`site-pat-${site.id}`}>{t("pat")}</Label>
              {site.patConfigured && !clearPat ? (
                <Badge variant="secondary" className="gap-1">
                  <Check className="h-3 w-3" />
                  {t("configured")}
                </Badge>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Input
                id={`site-pat-${site.id}`}
                type="password"
                value={dashboardPat}
                onChange={(event) => {
                  setDashboardPat(event.target.value);
                  if (event.target.value) setClearPat(false);
                }}
                disabled={pending || clearPat}
                autoComplete="new-password"
              />
              {site.patConfigured ? (
                <Button
                  type="button"
                  variant={clearPat ? "secondary" : "outline"}
                  onClick={() => {
                    setClearPat((value) => {
                      const next = !value;
                      setDashboardUserId(next ? "" : (site.dashboardUserId?.toString() ?? ""));
                      return next;
                    });
                    setDashboardPat("");
                  }}
                  disabled={pending}
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  {clearPat ? t("keepPat") : t("clearPat")}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`site-user-id-${site.id}`}>{t("uid")}</Label>
            <Input
              id={`site-user-id-${site.id}`}
              type="number"
              min={1}
              max={2_147_483_647}
              step={1}
              inputMode="numeric"
              value={dashboardUserId}
              onChange={(event) => setDashboardUserId(event.target.value)}
              disabled={pending || clearPat}
              required={hasEffectivePat}
              aria-invalid={credentialsInvalid}
              placeholder={t("uidPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{t("uidDescription")}</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`site-proxy-${site.id}`}>{t("proxy")}</Label>
            <Input
              id={`site-proxy-${site.id}`}
              value={proxyUrl}
              onChange={(event) => setProxyUrl(event.target.value)}
              disabled={pending}
              spellCheck={false}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ToggleRow
              id={`site-insecure-${site.id}`}
              label={t("allowInsecureHttp")}
              checked={allowInsecureHttp}
              onCheckedChange={setAllowInsecureHttp}
              disabled={pending}
            />
            <ToggleRow
              id={`site-proxy-fallback-${site.id}`}
              label={t("proxyFallback")}
              checked={proxyFallbackToDirect}
              onCheckedChange={setProxyFallbackToDirect}
              disabled={pending}
            />
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="destructive"
                disabled={pending || site.providerCount > 0}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("delete")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("deleteDescription", { site: site.siteKey })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete}>{t("confirmDelete")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              onClick={handleTest}
              disabled={pending || !credentialsReady}
            >
              {testMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <TestTube2 className="mr-2 h-4 w-4" />
              )}
              {t("test")}
            </Button>
            <Button type="button" onClick={handleSave} disabled={pending || credentialsInvalid}>
              {updateMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {t("save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
  id,
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border px-3">
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}
