"use client";

import { QRCode } from "antd";
import { ArrowLeft, CircleDollarSign, Clock3, Loader2, RefreshCw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@/i18n/routing";
import {
  cancelMyRechargeOrder,
  createMyRechargeOrder,
  getMyRechargeOrder,
  getRechargeAvailability,
  listMyRechargeOrders,
} from "@/lib/api-client/v1/actions/recharge";
import { calculateAlipayAmount } from "@/lib/recharge/money";
import type {
  RechargeAvailability,
  RechargeOrderStatus,
  RechargeOrderView,
} from "@/types/recharge";

interface RechargePageClientProps {
  returnHref: "/dashboard" | "/my-usage";
  keyName: string;
}

export function RechargePageClient({ returnHref, keyName }: RechargePageClientProps) {
  const t = useTranslations("recharge");
  const [availability, setAvailability] = useState<RechargeAvailability | null>(null);
  const [orders, setOrders] = useState<RechargeOrderView[]>([]);
  const [activeOrder, setActiveOrder] = useState<RechargeOrderView | null>(null);
  const [amount, setAmount] = useState("10");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const [nextAvailability, nextOrders] = await Promise.all([
      getRechargeAvailability(),
      listMyRechargeOrders(),
    ]);
    setAvailability(nextAvailability);
    setOrders(nextOrders.items);
    setActiveOrder((current) => {
      const currentFresh = current
        ? nextOrders.items.find((order) => order.id === current.id)
        : null;
      return currentFresh ?? nextOrders.items.find((order) => order.status === "pending") ?? null;
    });
  }, []);

  useEffect(() => {
    void load()
      .catch(() => toast.error(t("errors.load")))
      .finally(() => setLoading(false));
  }, [load, t]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!activeOrder || !["pending", "processing"].includes(activeOrder.status)) return;
    const timer = window.setInterval(() => {
      void getMyRechargeOrder(activeOrder.id)
        .then((order) => {
          setActiveOrder(order);
          setOrders((current) => current.map((item) => (item.id === order.id ? order : item)));
          if (["completed", "manual_closed"].includes(order.status)) void load();
        })
        .catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [activeOrder, load]);

  const payableAmount = useMemo(() => {
    try {
      return calculateAlipayAmount(amount, availability?.feeRatePercent ?? 0);
    } catch {
      return null;
    }
  }, [amount, availability?.feeRatePercent]);

  const remainingSeconds = activeOrder
    ? Math.max(0, Math.ceil((new Date(activeOrder.expiresAt).getTime() - now) / 1000))
    : 0;

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      const order = await createMyRechargeOrder(Number(amount).toFixed(2));
      setActiveOrder(order);
      await load();
    } catch {
      toast.error(t("errors.create"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!activeOrder) return;
    setCancelling(true);
    try {
      const order = await cancelMyRechargeOrder(activeOrder.id);
      setActiveOrder(order);
      await load();
      toast.success(t("messages.cancelled"));
    } catch {
      toast.error(t("errors.cancel"));
    } finally {
      setCancelling(false);
    }
  };

  const min = Number(availability?.minCreditUsd ?? 1);
  const max = Number(availability?.maxCreditUsd ?? 1000);
  const numericAmount = Number(amount);
  const amountValid =
    Number.isFinite(numericAmount) &&
    numericAmount >= min &&
    numericAmount <= max &&
    /^\d+(?:\.\d{1,2})?$/.test(amount);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("key", { name: keyName })}</p>
        </div>
        <Button asChild variant="outline">
          <Link href={returnHref}>
            <ArrowLeft className="h-4 w-4" />
            {t("return")}
          </Link>
        </Button>
      </div>

      {loading ? (
        <div className="flex min-h-56 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !availability?.eligible ? (
        <Alert variant="destructive">
          <AlertTitle>{t("unavailable.title")}</AlertTitle>
          <AlertDescription>
            {availability?.ineligibleReason === "key_limit_required"
              ? t("unavailable.keyLimit")
              : t("unavailable.disabled")}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CircleDollarSign className="h-5 w-5" />
                {activeOrder?.status === "pending" ? t("payment.title") : t("form.title")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {activeOrder?.status === "pending" && activeOrder.qrCode ? (
                <div className="flex flex-col items-center gap-5">
                  <div className="rounded-md border bg-white p-3">
                    <QRCode value={activeOrder.qrCode} size={220} bordered={false} />
                  </div>
                  <div className="grid w-full grid-cols-2 gap-3 text-sm">
                    <Metric label={t("payment.credit")} value={`$${activeOrder.creditUsd}`} />
                    <Metric label={t("payment.payable")} value={`¥${activeOrder.paidAmountCny}`} />
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock3 className="h-4 w-4" />
                    {t("payment.expires", {
                      minutes: String(Math.floor(remainingSeconds / 60)).padStart(2, "0"),
                      seconds: String(remainingSeconds % 60).padStart(2, "0"),
                    })}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCancel}
                    disabled={cancelling}
                  >
                    {cancelling ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <X className="h-4 w-4" />
                    )}
                    {t("payment.cancel")}
                  </Button>
                </div>
              ) : activeOrder?.status === "processing" ? (
                <div className="flex min-h-52 flex-col items-center justify-center gap-4 text-center">
                  <RefreshCw className="h-8 w-8 animate-spin text-primary" />
                  <div>
                    <p className="font-medium">{t("processing.title")}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("processing.description")}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="creditUsd">{t("form.amount")}</Label>
                    <Input
                      id="creditUsd"
                      type="number"
                      min={availability.minCreditUsd}
                      max={availability.maxCreditUsd}
                      step="0.01"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("form.range", {
                        min: availability.minCreditUsd,
                        max: availability.maxCreditUsd,
                      })}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <Metric label={t("form.credit")} value={`$${amount || "0"}`} />
                    <Metric label={t("form.payable")} value={`¥${payableAmount ?? "-"}`} />
                  </div>
                  <Button
                    className="w-full"
                    onClick={handleCreate}
                    disabled={!amountValid || submitting}
                  >
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t("form.submit")}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t("history.title")}</h2>
              <Badge variant="secondary">{orders.length}</Badge>
            </div>
            <div className="space-y-2">
              {orders.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {t("history.empty")}
                </p>
              ) : (
                orders.map((order) => (
                  <button
                    type="button"
                    key={order.id}
                    onClick={() => setActiveOrder(order)}
                    className="w-full rounded-md border bg-card p-3 text-left transition-colors hover:bg-muted/40"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-xs text-muted-foreground">
                        {order.orderNo}
                      </span>
                      <OrderStatusBadge status={order.status} />
                    </div>
                    <div className="mt-2 flex items-end justify-between gap-3">
                      <span className="font-medium">${order.creditUsd}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(order.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold">{value}</p>
    </div>
  );
}

function OrderStatusBadge({ status }: { status: RechargeOrderStatus }) {
  const t = useTranslations("recharge.status");
  const variant =
    status === "completed" ? "default" : status === "processing" ? "secondary" : "outline";
  return <Badge variant={variant}>{t(status)}</Badge>;
}
