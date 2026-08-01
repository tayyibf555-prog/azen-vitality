import { PatientRecordShell } from "@/components/client/patients/record/patient-record-shell";

export const dynamic = "force-dynamic";

// The patient record's persistent frame. A LAYOUT rather than a page, so navigating
// between the eleven tabs does not re-resolve the patient, repaint the header or
// re-render the pinned-notes band.
//
// There is deliberately NO loading.tsx anywhere under this route. A streamed
// loading.tsx once left authed pages unhydrated and every button on them dead
// (commit feb8677); it must not be reintroduced here.
export default async function PatientRecordLayout({
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
      basePath={`/c/${client}/patients/${id}`}
      listHref={`/c/${client}/patients`}
    >
      {children}
    </PatientRecordShell>
  );
}
