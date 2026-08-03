import { PatientRecordShell } from "@/components/client/patients/record/patient-record-shell";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

// The patient record's persistent frame. A LAYOUT rather than a page, so navigating
// between the eleven tabs does not re-resolve the patient, repaint the header or
// re-render the pinned-notes band.
//
// It also carries the module guard for the record's TWO nested pages
// (patients/[id]/page.tsx and patients/[id]/[tab]/page.tsx). Those pages do NOT
// inherit the guard on patients/page.tsx — that is a sibling route, not a parent —
// so without this line the record was reachable by direct URL for any role the
// layout guard let into the /c shell, even one denied the Patients module.
// Guarding here rather than in each page means a twelfth tab cannot ship unguarded.
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
  await requireModuleAccess("patients");
  return (
    // data-wide belongs to the RECORD, not to one tab. c/[client]/layout.tsx caps its
    // main column at max-w-[1400px] and drops the cap on has-[[data-wide]]. The Chart
    // tab used to be the only thing setting that marker, so the record ran full-bleed
    // on Chart and stayed capped and centred on the other ten - and because the marker
    // lives above the header and the tab strip, the ENTIRE record, chrome included,
    // resized every time you clicked a tab.
    //
    // Setting it here, on the layout that wraps every tab, makes the measure a property
    // of the record: one width, and it never changes as you navigate. The chart keeps
    // its own marker (it is in a contested path and this is idempotent - the has-[]
    // selector only asks whether ANY descendant carries the attribute).
    //
    // FULL-BLEED CONTAINER IS NOT FULL-BLEED CONTENT. A tab whose body needs a reading
    // measure constrains itself INTERNALLY - see UnavailablePanel's max-w-2xl - rather
    // than dragging the container's width back and reintroducing the jump.
    <div data-wide>
      <PatientRecordShell
        clientSlug={client}
        patientId={id}
        basePath={`/c/${client}/patients/${id}`}
        listHref={`/c/${client}/patients`}
      >
        {children}
      </PatientRecordShell>
    </div>
  );
}
