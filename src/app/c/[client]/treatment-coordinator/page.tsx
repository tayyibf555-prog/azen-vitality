import { TreatmentCoordinatorView } from "@/components/client/coordinator/treatment-coordinator-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function TreatmentCoordinatorPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  await requireModuleAccess("treatment-coordinator");
  return <TreatmentCoordinatorView clientSlug={client} />;
}
