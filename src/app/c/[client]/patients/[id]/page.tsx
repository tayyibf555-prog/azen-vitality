import { RecordTabContent } from "@/components/client/patients/record/record-tab-content";

export const dynamic = "force-dynamic";

// Details, the record's default tab. It lives at the record root rather than at
// /details so the default tab has exactly one URL.
export default async function PatientDetailsTabPage({
  params,
}: {
  params: Promise<{ client: string; id: string }>;
}) {
  const { client, id } = await params;
  return <RecordTabContent clientSlug={client} patientId={id} slug="details" />;
}
