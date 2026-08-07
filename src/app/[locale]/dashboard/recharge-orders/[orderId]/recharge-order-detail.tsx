"use client";

import { ArrowLeft, Ban, CheckCircle2, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/routing";
import {
  cancelRechargeOrderAdmin,
  closeRechargeOrderAdmin,
  confirmRechargeOrderAdmin,
  getRechargeOrderAdmin,
  retryRechargeOrderAdmin,
} from "@/lib/api-client/v1/actions/recharge";
import type { RechargeOrderView } from "@/types/recharge";

type ReasonAction = "confirm" | "cancel" | "close";

export function RechargeOrderDetail({ orderId }: { orderId: number }) {
  const t = useTranslations("recharge.admin.detail");
  const statusT = useTranslations("recharge.status");
  const [order, setOrder] = useState<RechargeOrderView | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [action, setAction] = useState<ReasonAction | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      setOrder(await getRechargeOrderAdmin(orderId));
    } catch {
      toast.error(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [orderId, t]);
  useEffect(() => {
    void load();
  }, [load]);

  const runReasonAction = async () => {
    if (!action || !reason.trim()) return;
    setWorking(true);
    try {
      const next =
        action === "confirm"
          ? await confirmRechargeOrderAdmin(orderId, reason)
          : action === "cancel"
            ? await cancelRechargeOrderAdmin(orderId, reason)
            : await closeRechargeOrderAdmin(orderId, reason);
      setOrder(next);
      setAction(null);
      setReason("");
      toast.success(t("done"));
    } catch {
      toast.error(t("actionFailed"));
    } finally {
      setWorking(false);
    }
  };

  const retry = async () => {
    setWorking(true);
    try {
      setOrder(await retryRechargeOrderAdmin(orderId));
      toast.success(t("done"));
    } catch {
      toast.error(t("actionFailed"));
    } finally {
      setWorking(false);
    }
  };

  if (loading || !order)
    return (
      <div className="flex min-h-56 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon">
            <Link href="/dashboard/recharge-orders">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{t("title")}</h1>
            <p className="font-mono text-xs text-muted-foreground">{order.orderNo}</p>
          </div>
        </div>
        <Badge variant={order.needsManualHandling ? "destructive" : "outline"}>
          {statusT(order.status)}
        </Badge>
      </div>

      {order.needsManualHandling ? (
        <Alert variant="destructive">
          <AlertTitle>{t("manualTitle")}</AlertTitle>
          <AlertDescription>{order.lastSettlementError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-x-8 gap-y-5 border-y py-6 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t("credit")} value={`$${order.creditUsd}`} />
        <Field label={t("paidAmount")} value={`¥${order.paidAmountCny}`} />
        <Field label={t("feeRate")} value={`${order.feeRatePercent}%`} />
        <Field label={t("user")} value={order.userName} />
        <Field label={t("key")} value={order.keyName} />
        <Field label={t("tradeNo")} value={order.alipayTradeNo ?? "-"} mono />
        <Field label={t("createdAt")} value={new Date(order.createdAt).toLocaleString()} />
        <Field
          label={t("paidAt")}
          value={order.paidAt ? new Date(order.paidAt).toLocaleString() : "-"}
        />
        <Field
          label={t("completedAt")}
          value={order.completedAt ? new Date(order.completedAt).toLocaleString() : "-"}
        />
        <Field label={t("retryCount")} value={String(order.retryCount)} />
        <Field label={t("reason")} value={order.manualReason ?? order.cancellationReason ?? "-"} />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {order.status === "pending" ||
        order.status === "cancelled" ||
        order.status === "processing" ? (
          <Button variant="outline" onClick={() => setAction("confirm")} disabled={working}>
            <CheckCircle2 className="h-4 w-4" />
            {t("confirm")}
          </Button>
        ) : null}
        {order.status === "pending" ? (
          <Button variant="outline" onClick={() => setAction("cancel")} disabled={working}>
            <Ban className="h-4 w-4" />
            {t("cancel")}
          </Button>
        ) : null}
        {order.status === "processing" ? (
          <Button variant="outline" onClick={retry} disabled={working}>
            <RefreshCw className="h-4 w-4" />
            {t("retry")}
          </Button>
        ) : null}
        {order.status === "processing" || order.status === "completed" ? (
          <Button variant="destructive" onClick={() => setAction("close")} disabled={working}>
            <RotateCcw className="h-4 w-4" />
            {t("close")}
          </Button>
        ) : null}
      </div>

      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action ? t(`actions.${action}`) : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reason">{t("reasonLabel")}</Label>
            <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)}>
              {t("back")}
            </Button>
            <Button onClick={runReasonAction} disabled={!reason.trim() || working}>
              {working ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 break-all text-sm font-medium ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}
