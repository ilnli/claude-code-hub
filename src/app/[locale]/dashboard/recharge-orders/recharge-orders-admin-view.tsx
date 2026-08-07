"use client";

import { AlertTriangle, Loader2, RefreshCw, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/routing";
import { listRechargeOrdersAdmin } from "@/lib/api-client/v1/actions/recharge";
import type { RechargeAdminOrderList, RechargeOrderStatus } from "@/types/recharge";

export function RechargeOrdersAdminView() {
  const t = useTranslations("recharge.admin.orders");
  const statusT = useTranslations("recharge.status");
  const [data, setData] = useState<RechargeAdminOrderList | null>(null);
  const [status, setStatus] = useState<RechargeOrderStatus | "">("");
  const [manualOnly, setManualOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await listRechargeOrdersAdmin({
          status: status || undefined,
          needsManualHandling: manualOnly,
          search: search || undefined,
        })
      );
    } catch {
      toast.error(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [manualOnly, search, status, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={data?.needsManualHandlingCount ? "destructive" : "secondary"}
            className="gap-1.5"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            {t("manualCount", { count: data?.needsManualHandlingCount ?? 0 })}
          </Badge>
          <Button variant="outline" size="icon" onClick={() => void load()} title={t("refresh")}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 border-y py-4">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("search")}
            className="pl-9"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as RechargeOrderStatus | "")}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{t("allStatuses")}</option>
          {(["pending", "processing", "cancelled", "completed", "manual_closed"] as const).map(
            (value) => (
              <option key={value} value={value}>
                {statusT(value)}
              </option>
            )
          )}
        </select>
        <Button
          variant={manualOnly ? "default" : "outline"}
          onClick={() => setManualOnly((value) => !value)}
        >
          {t("manualOnly")}
        </Button>
      </div>

      {loading ? (
        <div className="flex min-h-52 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : data?.items.length ? (
        <div className="overflow-x-auto border-y">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t("orderNo")}</th>
                <th className="px-4 py-3">{t("owner")}</th>
                <th className="px-4 py-3">{t("amount")}</th>
                <th className="px-4 py-3">{t("status")}</th>
                <th className="px-4 py-3">{t("createdAt")}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((order) => (
                <tr
                  key={order.id}
                  className={order.needsManualHandling ? "bg-destructive/5" : "border-t"}
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/recharge-orders/${order.id}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {order.orderNo}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <div>{order.userName}</div>
                    <div className="text-xs text-muted-foreground">{order.keyName}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>${order.creditUsd}</div>
                    <div className="text-xs text-muted-foreground">¥{order.paidAmountCny}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={order.needsManualHandling ? "destructive" : "outline"}>
                      {statusT(order.status)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {new Date(order.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="py-16 text-center text-sm text-muted-foreground">{t("empty")}</p>
      )}
    </div>
  );
}
