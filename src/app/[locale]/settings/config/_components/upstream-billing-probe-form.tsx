"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Power, Timer, TrendingUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { SystemSettings } from "@/types/system-config";

const upstreamBillingProbeSchema = z.object({
  upstreamBillingProbeEnabled: z.boolean(),
  upstreamBillingProbeIntervalMinutes: z.number().int().min(1).max(1440),
});

type UpstreamBillingProbeFormData = z.infer<typeof upstreamBillingProbeSchema>;

interface UpstreamBillingProbeFormProps {
  settings: SystemSettings;
  onSuccess?: () => void;
}

export function UpstreamBillingProbeForm({ settings, onSuccess }: UpstreamBillingProbeFormProps) {
  const t = useTranslations("settings.config.form");
  const tCommon = useTranslations("settings.common");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<UpstreamBillingProbeFormData>({
    resolver: zodResolver(upstreamBillingProbeSchema),
    defaultValues: {
      upstreamBillingProbeEnabled: settings.upstreamBillingProbeEnabled ?? false,
      upstreamBillingProbeIntervalMinutes: settings.upstreamBillingProbeIntervalMinutes ?? 30,
    },
  });

  const probeEnabled = watch("upstreamBillingProbeEnabled");

  const onSubmit = async (data: UpstreamBillingProbeFormData) => {
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/admin/system-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          siteTitle: settings.siteTitle,
          allowGlobalUsageView: settings.allowGlobalUsageView,
          ...data,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t("saveFailed"));
      }

      toast.success(t("upstreamBillingProbeSaved"));
      onSuccess?.();
    } catch (error) {
      console.error("Save error:", error);
      toast.error(error instanceof Error ? error.message : t("saveError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClassName =
    "bg-muted/50 border border-border rounded-lg focus:border-primary focus:ring-1 focus:ring-primary";

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      {/* Enable Upstream Billing Probe Toggle */}
      <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between hover:bg-white/[0.04] transition-colors">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 shrink-0">
            <Power className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {t("upstreamBillingProbeEnabled")}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("upstreamBillingProbeEnabledDesc")}
            </p>
          </div>
        </div>
        <Switch
          id="upstreamBillingProbeEnabled"
          checked={probeEnabled}
          onCheckedChange={(checked) => setValue("upstreamBillingProbeEnabled", checked)}
        />
      </div>

      {/* Conditional Settings */}
      {probeEnabled && (
        <div className="space-y-4 pl-4 border-l border-white/10">
          {/* Probe Interval */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 flex items-center justify-center rounded-md bg-blue-500/10 text-blue-400 shrink-0">
                <Timer className="h-3.5 w-3.5" />
              </div>
              <Label
                htmlFor="upstreamBillingProbeIntervalMinutes"
                className="text-sm font-medium text-foreground"
              >
                {t("upstreamBillingProbeIntervalRequired")}
              </Label>
            </div>
            <Input
              id="upstreamBillingProbeIntervalMinutes"
              type="number"
              min={1}
              max={1440}
              {...register("upstreamBillingProbeIntervalMinutes", { valueAsNumber: true })}
              placeholder={t("upstreamBillingProbeIntervalPlaceholder")}
              className={inputClassName}
            />
            {errors.upstreamBillingProbeIntervalMinutes && (
              <p className="text-sm text-destructive">
                {errors.upstreamBillingProbeIntervalMinutes.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("upstreamBillingProbeIntervalDesc")}</p>
          </div>

          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p>{t("upstreamBillingProbeHint")}</p>
          </div>
        </div>
      )}

      {/* Submit Button */}
      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {tCommon("saving")}
            </>
          ) : (
            t("saveConfig")
          )}
        </Button>
      </div>
    </form>
  );
}
