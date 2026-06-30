import { ReportsView } from "@/components/client/reports/reports-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("reports");
  return <ReportsView clientSlug={clientSlug} />;
}
