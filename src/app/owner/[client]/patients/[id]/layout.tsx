import { PatientRecordShell } from "@/components/client/patients/record/patient-record-shell";

export const dynamic = "force-dynamic";

// The owner tree's patient record. A thin wrapper over the same shell the client tree
// uses, differing only in basePath and listHref. No loading.tsx here either.
export default async function OwnerPatientRecordLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ client: string; id: string }>;
}) {
  const { client, id } = await params;
  return (
    <PatientRecordShell
      clientSlug={client}
      patientId={id}
      basePath={`/owner/${client}/patients/${id}`}
      listHref={`/owner/${client}/patients`}
    >
      {children}
    </PatientRecordShell>
  );
}
