import { getTranslations } from "next-intl/server";
import { SettingsPageHeader } from "../_components/settings-page-header";
import { PaymentSettingsForm } from "./payment-settings-form";

export const dynamic = "force-dynamic";

export default async function PaymentSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "recharge.admin.config" });
  return (
    <div className="space-y-6">
      <SettingsPageHeader title={t("title")} description={t("description")} icon="settings" />
      <PaymentSettingsForm />
    </div>
  );
}
