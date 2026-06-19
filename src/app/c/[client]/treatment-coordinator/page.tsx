import { TreatmentCoordinatorView } from "@/components/client/coordinator/treatment-coordinator-view";

export const dynamic = "force-dynamic";

export default async function TreatmentCoordinatorPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  return <TreatmentCoordinatorView clientSlug={client} />;
}
