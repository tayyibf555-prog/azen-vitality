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
    // Identical to c/[client]/patients/[id]/layout.tsx, and it has to be. The owner
    // tree renders the SAME PatientRecordShell under a layout carrying the SAME
    // max-w-[1400px] + has-[[data-wide]]:max-w-none rule, so a marker set on one tree
    // and not the other gives the owner a record that still jumps width between tabs
    // while /c does not. A module wired into one tree and not the other is a class of
    // failure this project has shipped once already.
    <div data-wide>
      <PatientRecordShell
        clientSlug={client}
        patientId={id}
        basePath={`/owner/${client}/patients/${id}`}
        listHref={`/owner/${client}/patients`}
      >
        {children}
      </PatientRecordShell>
    </div>
  );
}
