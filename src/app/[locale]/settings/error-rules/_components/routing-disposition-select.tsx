"use client";

import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RoutingDisposition } from "@/types/routing-error";

interface RoutingDispositionSelectProps {
  id: string;
  value: RoutingDisposition | "";
  onValueChange: (value: RoutingDisposition) => void;
}

export function RoutingDispositionSelect({
  id,
  value,
  onValueChange,
}: RoutingDispositionSelectProps) {
  const t = useTranslations("settings");

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground uppercase">
        {t("errorRules.dialog.routingDispositionLabel")}
      </Label>
      <Select value={value} onValueChange={(next) => onValueChange(next as RoutingDisposition)}>
        <SelectTrigger id={id} className="bg-muted/50 border-border">
          <SelectValue placeholder={t("errorRules.dialog.routingDispositionPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="request_terminal">
            {t("errorRules.dispositions.request_terminal")}
          </SelectItem>
          <SelectItem value="endpoint_capability_gap">
            {t("errorRules.dispositions.endpoint_capability_gap")}
          </SelectItem>
          <SelectItem value="provider_capability_gap">
            {t("errorRules.dispositions.provider_capability_gap")}
          </SelectItem>
          <SelectItem value="provider_failure">
            {t("errorRules.dispositions.provider_failure")}
          </SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {t("errorRules.dialog.routingDispositionHint")}
      </p>
    </div>
  );
}
