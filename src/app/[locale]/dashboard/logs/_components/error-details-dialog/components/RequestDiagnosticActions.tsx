"use client";

import { Copy, Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { buildRequestDiagnosticExport } from "@/lib/usage-logs/request-diagnostic-export";
import { copyTextToClipboard } from "@/lib/utils/clipboard";

export function RequestDiagnosticActions({ details }: { details: Record<string, unknown> }) {
  const t = useTranslations("dashboard.logs.details.diagnosticExport");

  const copy = async () => {
    try {
      const { content } = buildRequestDiagnosticExport(details);
      if (await copyTextToClipboard(content)) toast.success(t("copied"));
      else toast.error(t("copyFailed"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const download = () => {
    let url: string | undefined;
    try {
      const { filename, content } = buildRequestDiagnosticExport(details);
      url = URL.createObjectURL(new Blob([content], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      toast.error(t("exportFailed"));
    } finally {
      if (url) {
        const objectUrl = url;
        setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      }
    }
  };

  return (
    <div className="flex flex-wrap gap-2 pt-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={copy}
        data-request-diagnostic-action="copy"
      >
        <Copy className="mr-1.5 h-3.5 w-3.5" />
        {t("copy")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={download}
        data-request-diagnostic-action="download"
      >
        <Download className="mr-1.5 h-3.5 w-3.5" />
        {t("download")}
      </Button>
    </div>
  );
}
