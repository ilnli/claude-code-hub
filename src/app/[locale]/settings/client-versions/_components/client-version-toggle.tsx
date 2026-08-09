"use client";

import { Shield, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveSystemSettings } from "@/lib/api-client/v1/actions/system-config";
import { SettingsToggleRow } from "../../_components/ui/settings-ui";

interface ClientVersionToggleProps {
  enabled: boolean;
}

export function ClientVersionToggle({ enabled }: ClientVersionToggleProps) {
  const t = useTranslations("settings.clientVersions");
  const router = useRouter();
  const [isEnabled, setIsEnabled] = useState(enabled);
  const [isPending, startTransition] = useTransition();

  function handleToggle(checked: boolean) {
    startTransition(async () => {
      const result = await saveSystemSettings({ enableClientVersionCheck: checked });
      if (!result.ok) {
        toast.error(t("toggle.toggleFailed"));
        return;
      }
      setIsEnabled(checked);
      toast.success(checked ? t("toggle.enableSuccess") : t("toggle.disableSuccess"));
      router.refresh();
    });
  }

  return (
    <SettingsToggleRow
      title={t("toggle.enable")}
      description={t("toggle.description")}
      icon={isEnabled ? ShieldCheck : Shield}
      iconBgColor={isEnabled ? "bg-emerald-500/10" : "bg-muted/50"}
      iconColor={isEnabled ? "text-emerald-500" : "text-muted-foreground"}
      checked={isEnabled}
      onCheckedChange={handleToggle}
      disabled={isPending}
    />
  );
}
