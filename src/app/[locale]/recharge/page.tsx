import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { RechargePageClient } from "./recharge-page-client";

export const dynamic = "force-dynamic";

export default async function RechargePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await getSession({ allowReadOnlyAccess: true });
  if (!session) return redirect({ href: "/login?from=/recharge", locale });

  return (
    <RechargePageClient
      returnHref={
        session.user.role === "admin" || session.key.canLoginWebUi ? "/dashboard" : "/my-usage"
      }
      keyName={session.key.name}
    />
  );
}
