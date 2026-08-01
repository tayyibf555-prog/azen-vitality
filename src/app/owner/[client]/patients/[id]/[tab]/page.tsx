import { notFound } from "next/navigation";
import { RecordTabContent } from "@/components/client/patients/record/record-tab-content";
import { isPatientTab } from "@/lib/patient/tabs";

export const dynamic = "force-dynamic";

export default async function OwnerPatientTabPage({
  params,
}: {
  params: Promise<{ client: string; id: string; tab: string }>;
}) {
  const { client, id, tab } = await params;
  if (!isPatientTab(tab) || tab === "details") notFound();
  return <RecordTabContent clientSlug={client} patientId={id} slug={tab} />;
}
