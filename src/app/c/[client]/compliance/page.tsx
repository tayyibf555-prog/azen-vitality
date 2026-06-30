import { ComplianceView } from "@/components/client/compliance/compliance-view";

export const dynamic = "force-dynamic";

export default async function CompliancePage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <ComplianceView clientSlug={clientSlug} />;
}
