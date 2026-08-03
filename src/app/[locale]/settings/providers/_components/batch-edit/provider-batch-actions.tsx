"use client";

import { useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Pencil, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { syncProvidersUpstreamRateBatch } from "@/lib/api-client/v1/actions/providers";
import { cn } from "@/lib/utils";
import { invalidateProviderQueries } from "../invalidate-provider-queries";

export type BatchActionMode = "edit" | "delete" | "resetCircuit" | "test" | null;

export interface ProviderBatchActionsProps {
  selectedCount: number;
  /** 当前勾选的 provider id 列表（用于批量同步上游倍率） */
  selectedProviderIds?: number[];
  isVisible: boolean;
  onAction: (mode: BatchActionMode) => void;
  onClose: () => void;
  /** 批量同步上游倍率完成后的回调（如分组视图的数据刷新） */
  onSynced?: () => void;
}

export function ProviderBatchActions({
  selectedCount,
  selectedProviderIds = [],
  isVisible,
  onAction,
  onClose,
  onSynced,
}: ProviderBatchActionsProps) {
  const t = useTranslations("settings.providers.batchEdit");
  const queryClient = useQueryClient();
  const [syncRatePending, startSyncRateTransition] = useTransition();

  if (!isVisible || selectedCount === 0) {
    return null;
  }

  const handleSyncUpstreamRate = () => {
    if (selectedProviderIds.length === 0) return;
    startSyncRateTransition(async () => {
      try {
        const res = await syncProvidersUpstreamRateBatch(selectedProviderIds);
        if (!res.ok) {
          toast.error(t("syncRateFailed"), { description: res.error });
          return;
        }
        const summary = res.data;
        toast.success(
          t("syncRateSummary", {
            synced: summary?.synced ?? 0,
            unsupported: summary?.unsupported ?? 0,
            failed: summary?.failed ?? 0,
            skipped: summary?.skipped ?? 0,
          })
        );
        await invalidateProviderQueries(queryClient);
        onSynced?.();
      } catch {
        toast.error(t("syncRateFailed"));
      }
    });
  };

  return (
    <div
      className={cn(
        "fixed bottom-4 left-1/2 -translate-x-1/2 z-50",
        "bg-background/95 backdrop-blur border rounded-lg shadow-lg px-4 py-3",
        "transition-all duration-200"
      )}
    >
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium tabular-nums">
          {t("selectedCount", { count: selectedCount })}
        </span>

        <Separator orientation="vertical" className="h-6" />

        <Button size="sm" onClick={() => onAction("edit")}>
          <Pencil className="mr-2 h-4 w-4" />
          {t("actions.edit")}
        </Button>

        <Button size="sm" variant="outline" onClick={() => onAction("test")}>
          <FlaskConical className="mr-2 h-4 w-4" />
          {t("actions.test")}
        </Button>

        <Button size="sm" variant="outline" onClick={() => onAction("resetCircuit")}>
          <RotateCcw className="mr-2 h-4 w-4" />
          {t("actions.resetCircuit")}
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={handleSyncUpstreamRate}
          disabled={syncRatePending}
        >
          <RefreshCw className={cn("mr-2 h-4 w-4", syncRatePending && "animate-spin")} />
          {t("actions.syncRate")}
        </Button>

        <Button size="sm" variant="destructive" onClick={() => onAction("delete")}>
          <Trash2 className="mr-2 h-4 w-4" />
          {t("actions.delete")}
        </Button>

        <Separator orientation="vertical" className="h-6" />

        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("exitMode")}
        </Button>
      </div>
    </div>
  );
}
