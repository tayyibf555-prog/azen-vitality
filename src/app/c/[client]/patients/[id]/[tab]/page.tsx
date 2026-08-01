import { notFound } from "next/navigation";
import { RecordTabContent } from "@/components/client/patients/record/record-tab-content";
import { isPatientTab } from "@/lib/patient/tabs";

export const dynamic = "force-dynamic";

// The other ten tabs. An unknown slug is a 404, NEVER a silent fall back to Details:
// a mistyped tab that quietly shows a different one is how a reader ends up believing
// they checked something they did not.
export default async function PatientTabPage({
  params,
}: {
  params: Promise<{ client: string; id: string; tab: string }>;
}) {
  const { client, id, tab } = await params;
  if (!isPatientTab(tab) || tab === "details") notFound();
  return <RecordTabContent clientSlug={client} patientId={id} slug={tab} />;
}
