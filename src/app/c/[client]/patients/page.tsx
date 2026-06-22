import { PatientsView } from "@/components/client/patients/patients-view";

export const dynamic = "force-dynamic";

export default async function PatientsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <PatientsView clientSlug={clientSlug} />;
}
