import { notFound } from "next/navigation";
import { getClient, getSite } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { getPatientRecordInScope } from "@/lib/patient/record";
import { getOverride } from "@/lib/patient-status/repository";
import { readNotesForRecord } from "@/lib/patient-notes/server-read";
import { readMedicalReviewForHeader } from "@/lib/patient-medical/server-read";
import { logPatientView } from "@/lib/patient-recents/server";
import { patientTabHref } from "@/lib/patient/tabs";
import type { PatientAdminStatus } from "@/lib/patient-status/types";
import { PatientRecordHeader } from "./patient-record-header";
import { PatientTabStrip } from "./patient-tab-strip";
import { PinnedNotesBand } from "./pinned-notes-band";

/**
 * The record's persistent frame: the header, the pinned-notes band and the tab strip.
 *
 * It is rendered from a LAYOUT, not a page, which is the whole reason the tabs are
 * separate URL segments: a layout is preserved across sibling-segment navigation, so
 * switching tabs does not re-resolve the patient, repaint the header or re-render the
 * pinned band. A single page with ?tab= would re-run the whole force-dynamic page on
 * every tab click.
 *
 * Both trees use this: /c/[client]/patients/[id] and /owner/[client]/patients/[id]
 * differ only in `basePath` and `listHref`.
 *
 * SECURITY, and it fails closed at every step:
 *   1. an unknown client -> notFound()
 *   2. a patient that cannot be resolved -> notFound()
 *   3. a patient whose site is NOT in the site-switcher selection -> notFound()
 * A 404 rather than a 403 on step 3 is deliberate: a 403 would confirm that the
 * patient exists, which is exactly what an out-of-scope caller must not learn. This
 * mirrors the posture of the detail API route and of patients-view.
 */
export async function PatientRecordShell({
  clientSlug,
  patientId,
  basePath,
  listHref,
  children,
}: {
  clientSlug: string;
  patientId: string;
  /** e.g. /c/vitality/patients/42. The tab strip appends each tab's segment. */
  basePath: string;
  /** Back to the list. The page has no Escape, no backdrop and no X. */
  listHref: string;
  children: React.ReactNode;
}) {
  const client = getClient(clientSlug);
  if (!client) notFound();

  const scope = await getViewScope(client.id);
  // getPatientRecord performs NO permission check of its own by design; the scope
  // check happens here, and getPatientRecordInScope returns null for "does not exist"
  // and "outside your scope" alike so the 404 below cannot distinguish them.
  const record = await getPatientRecordInScope(patientId, scope.siteIds);
  if (!record) notFound();

  // THE RECENTS LOG. Deliberately placed AFTER both notFound() guards above: by
  // this line the patient has been resolved AND checked against the site-switcher
  // scope, so what gets recorded is only ever a patient this user was actually
  // allowed to see — and the name and site id are already in hand rather than
  // costing a second read. This component is also the single seam that BOTH trees
  // (/c and /owner) funnel every record open through, which is why the call is
  // here and not duplicated in two page files.
  //
  // VOIDED RATHER THAN AWAITED, and that is the tradeoff taken with eyes open.
  // Awaiting would put a database write in front of every patient record open, on
  // the one page in the platform whose whole design — a layout rather than a page,
  // a server-seeded notes band — exists so that it paints in a single pass. The
  // price of voiding is that Next may finish the response before the insert lands
  // and the opening is then not recorded. A dropped entry in a "where was I" list
  // is the cheapest failure on offer here.
  //
  // This is safe ONLY because logPatientView cannot reject: it catches at its own
  // boundary, session lookup included. A floating promise that CAN reject is an
  // unhandled rejection at the process level, which would be a far worse outcome
  // than the feature simply not working.
  void logPatientView({
    clientId: client.id,
    patientId: record.patient.id,
    patientName: record.patient.name,
    siteId: record.patient.siteId,
  });

  const siteName = getSite(record.patient.siteId)?.name ?? record.patient.siteId;
  // A failed override read must not 500 the record, and it must not be SILENT either.
  // getOverride throws on any database error, and catching it to null made the header
  // fall through to Dentally's active flag and render a green "Active" pill for a
  // patient the practice may have marked do_not_contact. The read's own success is
  // carried to the header, which says so in that same slot instead.
  const nowIso = new Date().toISOString();
  const [override, notes, medicalReview] = await Promise.all([
    getOverride(record.patient.siteId, record.patient.id).then(
      (o) => ({ ok: true, status: o?.status ?? null }),
      () => ({ ok: false, status: null as PatientAdminStatus | null }),
    ),
    // The pinned band's own list, read here so the band paints in its final shape
    // rather than pushing the tab strip down a round trip later.
    readNotesForRecord(record.patient.siteId, record.patient.id),
    // The header's medical pill. Gated + fail-soft inside the helper: null when the
    // feature is off (the pill then shows the Dentally alert mirror alone), and
    // { ok:false } on a read failure (the pill says "not read" rather than "none").
    readMedicalReviewForHeader({
      siteId: record.patient.siteId,
      patientId: record.patient.id,
      appointments: record.detail.appointments,
      nowIso,
    }),
  ]);

  return (
    <div className="space-y-3">
      <PatientRecordHeader
        patient={record.patient}
        derived={record.derived}
        reads={record.reads}
        siteName={siteName}
        overrideStatus={override.status}
        overrideUnavailable={!override.ok}
        listHref={listHref}
        medicalHref={patientTabHref(basePath, "medical")}
        medicalReview={medicalReview}
      />
      {/* Above the tab strip on purpose: a pinned note must reach the reader whichever
          tab they are on, exactly as Dentally's band does. Seeded from the server read
          above so it is in its final shape on the first paint and the tab strip below
          it does not move once the notes arrive. */}
      <PinnedNotesBand
        siteId={record.patient.siteId}
        patientId={record.patient.id}
        clientSlug={clientSlug}
        initial={notes}
      />
      <PatientTabStrip basePath={basePath} />
      <div className="pt-1">{children}</div>
    </div>
  );
}
