import { PatientsView } from "@/components/client/patients/patients-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function PatientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ client: string }>;
  searchParams: Promise<{ patient?: string | string[] }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("patients");
  // ?patient= arrives from the diary panel and the command palette. It is resolved
  // SERVER-side, because the table only holds a bounded first slice of a 52,000
  // patient book: without this the link silently strips the parameter and does
  // nothing for most patients, and a dead link on the diary is worse than no link.
  const { patient } = await searchParams;
  const patientId = Array.isArray(patient) ? patient[0] : patient;
  return <PatientsView clientSlug={clientSlug} patientId={patientId ?? null} />;
}
