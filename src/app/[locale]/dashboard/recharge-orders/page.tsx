import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { RechargeOrdersAdminView } from "./recharge-orders-admin-view";

export default async function RechargeOrdersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();
  if (session?.user.role !== "admin") return redirect({ href: "/dashboard", locale });
  return <RechargeOrdersAdminView />;
}
