"use client";

import { CheckCircle2, Loader2, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Section } from "@/components/section";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  getRechargePaymentConfig,
  updateRechargePaymentConfig,
} from "@/lib/api-client/v1/actions/recharge";
import type { RechargePaymentConfigPublic } from "@/types/recharge";

interface PaymentFormState {
  enabled: boolean;
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  productName: string;
  notifyDomain: string;
  feeRatePercent: string;
  minCreditUsd: string;
  maxCreditUsd: string;
}

const EMPTY_FORM: PaymentFormState = {
  enabled: false,
  appId: "",
  privateKey: "",
  alipayPublicKey: "",
  productName: "",
  notifyDomain: "",
  feeRatePercent: "0",
  minCreditUsd: "1",
  maxCreditUsd: "1000",
};

export function PaymentSettingsForm() {
  const t = useTranslations("recharge.admin.config");
  const [config, setConfig] = useState<RechargePaymentConfigPublic | null>(null);
  const [form, setForm] = useState<PaymentFormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [replaceKeys, setReplaceKeys] = useState(true);

  useEffect(() => {
    void getRechargePaymentConfig()
      .then((value) => {
        setConfig(value);
        setReplaceKeys(!(value.privateKeyConfigured && value.alipayPublicKeyConfigured));
        setForm({
          enabled: value.enabled,
          appId: value.appId,
          privateKey: "",
          alipayPublicKey: "",
          productName: value.productName,
          notifyDomain: value.notifyDomain ?? "",
          feeRatePercent: value.feeRatePercent,
          minCreditUsd: value.minCreditUsd,
          maxCreditUsd: value.maxCreditUsd,
        });
      })
      .catch(() => toast.error(t("loadFailed")))
      .finally(() => setLoading(false));
  }, [t]);

  const update = <K extends keyof PaymentFormState>(key: K, value: PaymentFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSave = async () => {
    const privateKey = form.privateKey.trim();
    const alipayPublicKey = form.alipayPublicKey.trim();
    if (replaceKeys && (!privateKey || !alipayPublicKey)) {
      toast.error(t("keysRequired"));
      return;
    }
    setSaving(true);
    try {
      const next = await updateRechargePaymentConfig({
        enabled: form.enabled,
        appId: form.appId,
        ...(replaceKeys ? { privateKey, alipayPublicKey } : {}),
        productName: form.productName,
        notifyDomain: form.notifyDomain || null,
        feeRatePercent: form.feeRatePercent,
        minCreditUsd: form.minCreditUsd,
        maxCreditUsd: form.maxCreditUsd,
      });
      setConfig(next);
      setForm((current) => ({ ...current, privateKey: "", alipayPublicKey: "" }));
      setReplaceKeys(!(next.privateKeyConfigured && next.alipayPublicKeyConfigured));
      toast.success(t("saved"));
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-52 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <Section title={t("sectionTitle")} description={t("sectionDescription")} icon="settings">
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4 rounded-md border p-4">
          <div>
            <p className="text-sm font-medium">{t("enabled")}</p>
            <p className="text-xs text-muted-foreground">{t("enabledDescription")}</p>
          </div>
          <Switch checked={form.enabled} onCheckedChange={(value) => update("enabled", value)} />
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <Field label={t("appId")} htmlFor="appId">
            <Input
              id="appId"
              value={form.appId}
              onChange={(e) => update("appId", e.target.value)}
            />
          </Field>
          <Field label={t("productName")} htmlFor="productName">
            <Input
              id="productName"
              value={form.productName}
              onChange={(e) => update("productName", e.target.value)}
            />
          </Field>
          <Field
            label={t("privateKey")}
            htmlFor="privateKey"
            status={
              replaceKeys && form.privateKey
                ? t("replacementPending")
                : config?.privateKeyConfigured
                  ? t("configured")
                  : undefined
            }
          >
            <Textarea
              id="privateKey"
              rows={5}
              value={form.privateKey}
              required={replaceKeys}
              disabled={!replaceKeys}
              placeholder={!replaceKeys ? t("secretPlaceholder") : undefined}
              onChange={(e) => update("privateKey", e.target.value)}
            />
          </Field>
          <Field
            label={t("alipayPublicKey")}
            htmlFor="alipayPublicKey"
            status={
              replaceKeys && form.alipayPublicKey
                ? t("replacementPending")
                : config?.alipayPublicKeyConfigured
                  ? t("configured")
                  : undefined
            }
          >
            <Textarea
              id="alipayPublicKey"
              rows={5}
              value={form.alipayPublicKey}
              required={replaceKeys}
              disabled={!replaceKeys}
              placeholder={!replaceKeys ? t("secretPlaceholder") : undefined}
              onChange={(e) => update("alipayPublicKey", e.target.value)}
            />
          </Field>
          {config?.privateKeyConfigured && config.alipayPublicKeyConfigured ? (
            <div className="flex items-center gap-2 md:col-span-2">
              <Checkbox
                id="replacePaymentKeys"
                checked={replaceKeys}
                onCheckedChange={(checked) => {
                  setReplaceKeys(checked === true);
                  if (checked !== true) {
                    setForm((current) => ({
                      ...current,
                      privateKey: "",
                      alipayPublicKey: "",
                    }));
                  }
                }}
              />
              <Label htmlFor="replacePaymentKeys">{t("replaceKeys")}</Label>
            </div>
          ) : null}
          <Field label={t("notifyDomain")} htmlFor="notifyDomain">
            <Input
              id="notifyDomain"
              type="url"
              value={form.notifyDomain}
              onChange={(e) => update("notifyDomain", e.target.value)}
              placeholder="https://example.com"
            />
          </Field>
          <Field label={t("feeRate")} htmlFor="feeRatePercent">
            <Input
              id="feeRatePercent"
              type="number"
              min="0"
              max="99.9999"
              step="0.0001"
              value={form.feeRatePercent}
              onChange={(e) => update("feeRatePercent", e.target.value)}
            />
          </Field>
          <Field label={t("minCredit")} htmlFor="minCreditUsd">
            <Input
              id="minCreditUsd"
              type="number"
              min="0.01"
              step="0.01"
              value={form.minCreditUsd}
              onChange={(e) => update("minCreditUsd", e.target.value)}
            />
          </Field>
          <Field label={t("maxCredit")} htmlFor="maxCreditUsd">
            <Input
              id="maxCreditUsd"
              type="number"
              min="0.01"
              step="0.01"
              value={form.maxCreditUsd}
              onChange={(e) => update("maxCreditUsd", e.target.value)}
            />
          </Field>
        </div>

        {config?.createdAt ? (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>
              {t("activeVersion", {
                id: config.id ?? 0,
                time: new Date(config.createdAt).toLocaleString(),
              })}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t("save")}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function Field({
  label,
  htmlFor,
  status,
  children,
}: {
  label: string;
  htmlFor: string;
  status?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={htmlFor}>{label}</Label>
        {status ? (
          <span className="flex items-center gap-1 text-xs text-emerald-600">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {status}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}
