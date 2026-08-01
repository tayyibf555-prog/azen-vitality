import { RecordTabContent } from "@/components/client/patients/record/record-tab-content";

export const dynamic = "force-dynamic";

export default async function OwnerPatientDetailsTabPage({
  params,
}: {
  params: Promise<{ client: string; id: string }>;
}) {
  const { client, id } = await params;
  return <RecordTabContent clientSlug={client} patientId={id} slug="details" />;
}
