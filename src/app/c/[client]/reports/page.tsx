import { ReportsView } from "@/components/client/reports/reports-view";

export const dynamic = "force-dynamic";

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <ReportsView clientSlug={clientSlug} />;
}
