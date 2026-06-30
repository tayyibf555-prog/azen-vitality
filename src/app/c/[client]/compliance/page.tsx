import { ComplianceView } from "@/components/client/compliance/compliance-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function CompliancePage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("compliance");
  return <ComplianceView clientSlug={clientSlug} />;
}
