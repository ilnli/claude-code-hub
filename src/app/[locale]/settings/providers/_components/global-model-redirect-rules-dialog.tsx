"use client";

import { ArrowRight, ChevronsUpDown, Loader2, Route } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fetchSystemSettings, saveSystemSettings } from "@/lib/api-client/v1/actions/system-config";
import { resolveModelMapping } from "@/lib/model-mapping";
import type { GlobalModelRedirectRule } from "@/types/model-mapping";
import type { ProviderDisplay, ProviderModelRedirectRule } from "@/types/provider";
import { ModelRedirectEditor } from "./model-redirect-editor";

type EditableRule = GlobalModelRedirectRule & { editorId: string };

function getEditorId(rule: ProviderModelRedirectRule): string {
  return (rule as EditableRule).editorId;
}

interface GlobalModelRedirectRulesDialogProps {
  providers: ProviderDisplay[];
}

export function GlobalModelRedirectRulesDialog({ providers }: GlobalModelRedirectRulesDialogProps) {
  const t = useTranslations("settings.providers.globalModelRedirect");
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<EditableRule[] | null>(null);
  const nextRuleId = useRef(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [providerId, setProviderId] = useState(String(providers[0]?.id ?? ""));
  const provider = providers.find((item) => String(item.id) === providerId);
  const preview =
    rules && provider && model.trim() ? resolveModelMapping(model.trim(), provider, rules) : null;

  async function load() {
    setLoading(true);
    setRules(null);
    setError(null);
    try {
      const result = await fetchSystemSettings();
      if (result.ok)
        setRules(
          (result.data.globalModelRedirects ?? []).map((rule) => ({
            ...rule,
            editorId: String(nextRuleId.current++),
          }))
        );
      else setError(result.error || t("loadFailed"));
    } catch {
      setError(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!rules) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveSystemSettings({
        globalModelRedirects: rules.map(({ editorId: _editorId, ...rule }) => rule),
      });
      if (result.ok) {
        toast.success(t("saved"));
        setOpen(false);
      } else setError(result.error || t("saveFailed"));
    } catch {
      setError(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        setOpen(next);
        if (next) void load();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-global-redirect-trigger>
          <Route className="h-4 w-4" />
          {t("title")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("loading")}
          </p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!loading && !rules && (
          <Button variant="outline" onClick={() => void load()} data-global-redirect-retry>
            {t("retry")}
          </Button>
        )}
        {rules && (
          <>
            <ModelRedirectEditor
              value={rules}
              allowDuplicateRules
              getRuleKey={getEditorId}
              disabled={saving}
              onChange={(next) =>
                setRules(
                  next.map((rule) => ({
                    ...rule,
                    editorId: getEditorId(rule) ?? String(nextRuleId.current++),
                    excludedProviderIds:
                      (rule as GlobalModelRedirectRule).excludedProviderIds ?? [],
                  }))
                )
              }
              renderRuleDetails={(_rule, index) => (
                <div className="mt-2 border-t pt-2">
                  <ProviderExclusions
                    providers={providers}
                    selected={rules[index].excludedProviderIds}
                    index={index}
                    disabled={saving}
                    onChange={(excludedProviderIds) =>
                      setRules(
                        rules.map((rule, ruleIndex) =>
                          ruleIndex === index ? { ...rule, excludedProviderIds } : rule
                        )
                      )
                    }
                  />
                </div>
              )}
            />
            <div className="space-y-3 rounded-lg border bg-muted/10 p-4">
              <div>
                <h3 className="text-sm font-medium">{t("previewTitle")}</h3>
                <p className="text-xs text-muted-foreground">{t("previewDescription")}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="global-model-preview">{t("model")}</Label>
                  <Input
                    id="global-model-preview"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    onInput={(event) => setModel(event.currentTarget.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="global-provider-preview">{t("provider")}</Label>
                  <select
                    id="global-provider-preview"
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={providerId}
                    onChange={(event) => setProviderId(event.target.value)}
                    disabled={providers.length === 0}
                  >
                    {providers.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {providers.length === 0 && (
                <p className="text-xs text-muted-foreground">{t("noProviders")}</p>
              )}
              {preview && (
                <div data-global-redirect-preview className="space-y-2 text-sm">
                  <p className="break-all">
                    {t("result")} <code>{preview.redirectedModel}</code>
                  </p>
                  <ol className="space-y-2">
                    {preview.steps.map((step, index) => (
                      <li
                        key={`${index}:${step.ruleIndex}`}
                        data-global-redirect-step
                        className="rounded-md border bg-background p-2"
                      >
                        <p className="text-xs text-muted-foreground">
                          {t(step.source === "provider" ? "providerRule" : "globalRule", {
                            index: step.ruleIndex + 1,
                          })}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 break-all">
                          <code>{step.inputModel}</code>
                          <ArrowRight className="h-3 w-3 shrink-0" />
                          <code>{step.outputModel}</code>
                        </div>
                      </li>
                    ))}
                  </ol>
                  <p className="text-xs text-muted-foreground">
                    {t(`stopReasons.${preview.stopReason}`)}
                  </p>
                </div>
              )}
            </div>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          {rules && (
            <Button disabled={saving} onClick={() => void save()} data-global-redirect-save>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderExclusions({
  providers,
  selected,
  index,
  disabled,
  onChange,
}: {
  providers: ProviderDisplay[];
  selected: number[];
  index: number;
  disabled: boolean;
  onChange: (ids: number[]) => void;
}) {
  const t = useTranslations("settings.providers.globalModelRedirect");
  const [search, setSearch] = useState("");
  const visibleProviders = providers.filter((provider) =>
    provider.name.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="space-y-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            data-global-redirect-exclusions={index}
            className="w-full justify-between"
          >
            {selected.length ? t("excludedCount", { count: selected.length }) : t("allProviders")}
            <ChevronsUpDown className="h-3 w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 space-y-2" align="start">
          <Label htmlFor={`excluded-search-${index}`}>{t("excludedProviders")}</Label>
          <Input
            id={`excluded-search-${index}`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onInput={(event) => setSearch(event.currentTarget.value)}
            placeholder={t("searchProviders")}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange([])}
            disabled={!selected.length}
          >
            {t("clearExclusions")}
          </Button>
          <div className="max-h-56 space-y-2 overflow-y-auto">
            {visibleProviders.map((provider) => (
              <label key={provider.id} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  data-global-redirect-exclude={provider.id}
                  checked={selected.includes(provider.id)}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked
                        ? [...selected, provider.id]
                        : selected.filter((id) => id !== provider.id)
                    )
                  }
                />
                {provider.name}
              </label>
            ))}
            {visibleProviders.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("noProviders")}</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <p className="text-xs text-muted-foreground">{t("exclusionsHint")}</p>
    </div>
  );
}
