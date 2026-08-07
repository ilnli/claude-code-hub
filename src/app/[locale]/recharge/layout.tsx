import type { ReactNode } from "react";
import { redirect } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { DashboardHeader } from "../dashboard/_components/dashboard-header";

export default async function RechargeLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession({ allowReadOnlyAccess: true });
  if (!session) return redirect({ href: "/login?from=/recharge", locale });

  const hasFullDashboard = session.user.role === "admin" || session.key.canLoginWebUi;
  return (
    <div className="min-h-[var(--cch-viewport-height,100vh)] bg-background">
      {hasFullDashboard ? <DashboardHeader session={session} locale={locale} /> : null}
      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 md:py-8">{children}</main>
    </div>
  );
}
