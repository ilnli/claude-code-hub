"use client";

import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyTextToClipboard } from "@/lib/utils/clipboard";
import { PUBLIC_ERROR_I18N_KEYS, type PublicErrorCode } from "@/types/public-error";

interface PublicErrorDetailsDialogProps {
  trigger: ReactNode;
  code: PublicErrorCode;
  sessionId: string | null;
}

export function PublicErrorDetailsDialog({
  trigger,
  code,
  sessionId,
}: PublicErrorDetailsDialogProps) {
  const t = useTranslations("myUsage.logs.errorDetails");
  const tErrors = useTranslations("errors");

  const copySessionId = async () => {
    if (!sessionId) return;
    if (await copyTextToClipboard(sessionId)) toast.success(t("copied"));
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" className="h-auto p-0 font-normal hover:bg-transparent">
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">{t("reason")}</div>
            <p className="text-sm text-muted-foreground">{tErrors(PUBLIC_ERROR_I18N_KEYS[code])}</p>
          </div>
          {sessionId ? (
            <div className="space-y-1">
              <div className="text-sm font-medium">{t("sessionId")}</div>
              <div className="flex items-center gap-2 rounded border bg-muted/40 px-3 py-2">
                <code className="min-w-0 flex-1 break-all text-xs">{sessionId}</code>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" onClick={copySessionId}>
                      <Copy className="h-4 w-4" />
                      <span className="sr-only">{t("copy")}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("copy")}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
