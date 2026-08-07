import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { RechargeOrderDetail } from "./recharge-order-detail";

export default async function RechargeOrderDetailPage({
  params,
}: {
  params: Promise<{ locale: string; orderId: string }>;
}) {
  const { locale, orderId } = await params;
  const session = await getSession();
  if (session?.user.role !== "admin") return redirect({ href: "/dashboard", locale });
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0)
    return redirect({ href: "/dashboard/recharge-orders", locale });
  return <RechargeOrderDetail orderId={id} />;
}
