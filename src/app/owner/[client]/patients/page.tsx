import { PatientsView } from "@/components/client/patients/patients-view";

export const dynamic = "force-dynamic";

// The owner tree's patients list.
//
// It exists as a DEDICATED folder rather than as a branch of /owner/[client]/[module]
// for two reasons. First, the record needs deeper segments ([id] and [id]/[tab]) and
// the module route has none. Second, it fixes a real defect in passing: the module
// route takes no `searchParams` at all, so ?patient=<id> did nothing whatsoever in the
// owner tree while working in the client tree.
//
// A static `patients` segment shadows [module] for this segment only, so
// `module === "patients"` in that if-chain is now unreachable. It is deliberately left
// in place: owner-module-coverage.test.ts matches on those literals, and removing the
// branch would fail the test without weakening it, which costs nothing to avoid.
export default async function OwnerPatientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ client: string }>;
  searchParams: Promise<{ patient?: string | string[] }>;
}) {
  const { client: clientSlug } = await params;
  const { patient } = await searchParams;
  const patientId = Array.isArray(patient) ? patient[0] : patient;
  return <PatientsView clientSlug={clientSlug} patientId={patientId ?? null} basePath={`/owner/${clientSlug}`} />;
}
