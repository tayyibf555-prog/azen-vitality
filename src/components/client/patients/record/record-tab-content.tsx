import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getClient, getSite } from "@/lib/mock/clients";
import {
  CORRESPONDENCE_VIEW_COOKIE,
  parseCorrespondenceView,
} from "@/lib/patient/correspondence-view";
import { getViewScope } from "@/lib/site-view";
import { getPatientRecordInScope } from "@/lib/patient/record";
import { getOverride } from "@/lib/patient-status/repository";
import { numberHealthFor, type NumberHealth } from "@/lib/messaging/number-health";
import { getPatientCorrespondence } from "@/lib/inbox/correspondence";
import { getSessionUser } from "@/lib/auth/session";
import { listResponsesForPatient } from "@/lib/triage/repository";
import { projectSummary } from "@/lib/triage/summary";
import type { TriageResponse } from "@/lib/triage/types";
import { listPatientAudit, type PatientAuditEntry } from "@/lib/patient/profile-audit";
import { listTargets as listRecallTargets, listTouches as listRecallTouches } from "@/lib/recall/repository";
import { generateTasksWithHealth } from "@/lib/task-queue/generate";
import type { PatientTabSlug } from "@/lib/patient/tabs";
import type { PatientAdminStatus } from "@/lib/patient-status/types";
import type { ReactivationTouch } from "@/lib/reactivation/types";
import type { RecallTarget } from "@/lib/recall/types";
import { TabAccount } from "./tab-account";
import { TabAppointments } from "./tab-appointments";
import { TabAudit } from "./tab-audit";
import { TabCorrespondence } from "./tab-correspondence";
import { TabDetails } from "./tab-details";
import { TabNotes } from "./tab-notes";
import { TabChart } from "./tab-chart";
import { TabMedical } from "./tab-medical";
import { TabPerio } from "./tab-perio";
import { TabRecalls } from "./tab-recalls";
import { TabTasks } from "./tab-tasks";
import { RecordSummary } from "./record-summary";
import { PreVisitSummaryPanel } from "./previsit-summary-panel";

/**
 * One tab's content, resolved server-side.
 *
 * It re-resolves the record rather than receiving it from the layout, because a layout
 * cannot pass data to its children in the App Router. That costs nothing: the layout's
 * read and this one share a single 30-second cache entry keyed on (siteId, patientId),
 * so the second call is a cache hit and the two are guaranteed to be the SAME object.
 * That is also what stops the header and the panel below it ever disagreeing.
 *
 * Only the data the SELECTED tab needs is loaded. Correspondence does not fetch the
 * audit trail, Tasks does not fetch the recall touches, and so on: the record is opened
 * all day and most opens read one tab.
 *
 * Medical NO LONGER renders UnavailablePanel, and it left the panel for the same
 * reason perio did, not the chart's. The chart became fillable because a Dentally
 * read was found. Medical's Dentally endpoint (/v1/medical_histories) EXISTS but is
 * permanently empty for this practice, so what changed is that this platform now
 * AUTHORS a medical-history questionnaire + review log of its own — a second
 * clinical record, gated off, which renders its own screen (the alert mirror, the
 * questionnaire, the review log) rather than the shared "we cannot read this" panel.
 *
 * CHART IS NO LONGER ONE OF THEM. It renders from /v1/treatment_plan_items, which is
 * a real read, so its tab entry moved to "partial" and its cannotRead sentence was
 * blanked in the same commit.
 *
 * NOR IS PERIO, AND IT LEFT THE PANEL FOR THE OPPOSITE REASON TO THE CHART. The chart
 * became fillable because a Dentally read was found. Nothing was found for perio:
 * Dentally exposes no periodontal resource of any kind, and PATIENT_TABS still says
 * "unreadable" because that sentence is about DENTALLY and is still true. What changed
 * is that this platform can now AUTHOR periodontal findings of its own — a second
 * clinical record, which is why it ships gated off and why the tab renders its own
 * gate notice rather than the shared panel. UnavailablePanel says "we cannot read
 * this"; the perio tab has to say "we can hold this, we are not holding it, and the
 * record you want is in Dentally", which is a different sentence and a different
 * screen.
 */
export async function RecordTabContent({
  clientSlug,
  patientId,
  slug,
}: {
  clientSlug: string;
  patientId: string;
  slug: PatientTabSlug;
}) {
  const client = getClient(clientSlug);
  if (!client) notFound();
  const scope = await getViewScope(client.id);
  const record = await getPatientRecordInScope(patientId, scope.siteIds);
  // Same 404 for "does not exist" and "outside your scope": see getPatientRecordInScope.
  if (!record) notFound();

  const { patient, detail, derived, reads } = record;
  const nowIso = new Date().toISOString();
  const siteId = patient.siteId;

  if (slug === "medical") {
    // No longer the UnavailablePanel: Dentally's /v1/medical_histories exists but is
    // permanently empty for this practice, so this platform AUTHORS a medical-history
    // questionnaire + review log of its own (gated off, perio archetype). The ONE
    // Dentally mirror is patient.medicalAlert, already on the record read and passed
    // straight through. Appointments feed the appointment-aware review rule. nowIso,
    // not a clock read inside the tab, so the header and this panel share one "now".
    return (
      <TabMedical
        clientSlug={clientSlug}
        siteId={siteId}
        patientId={patient.id}
        nowIso={nowIso}
        medicalAlert={patient.medicalAlert}
        medicalAlertText={patient.medicalAlertText}
        appointments={detail.appointments}
      />
    );
  }

  if (slug === "perio") {
    // nowIso, not a clock read inside the tab. The entry grid stamps its LOCAL
    // preview with the instant the screen was opened; the record itself is stamped
    // by the server on save. Sharing this record's one "now" is what stops the
    // header and the panel below it ever disagreeing about when this page is.
    return (
      <TabPerio
        clientSlug={clientSlug}
        siteId={siteId}
        patientId={patient.id}
        nowIso={nowIso}
      />
    );
  }

  if (slug === "chart") {
    // No nowIso, and it is the only tab that takes none. The others render an age
    // and so must share one "now"; the chart renders no present tense at all. Every
    // time it prints comes from ChartRead.fetchedAt, captured inside the read at
    // fetch time, so a chart left open on a surgery screen states when it was read
    // rather than implying it is current.
    return <TabChart clientSlug={clientSlug} siteId={siteId} patientId={patient.id} />;
  }

  if (slug === "details") {
    // numberHealth is best effort: null simply renders no chip. The OVERRIDE is not.
    // getOverride throws on any database error, and catching it to null made the tab
    // present Dentally's active flag instead, so a patient the practice marked
    // do_not_contact after a complaint read as an ordinary active patient. A
    // suppression marker that could not be read must say so.
    const [override, numberHealth] = await Promise.all([
      readOverride(siteId, patient.id),
      numberHealthFor(patient.phone).catch(() => null as NumberHealth | null),
    ]);
    return (
      <div className="space-y-4">
        <RecordSummary derived={derived} reads={reads} nowIso={nowIso} />
        <TabDetails
          patient={patient}
          detail={detail}
          derived={derived}
          reads={reads}
          numberHealth={numberHealth}
          siteName={getSite(siteId)?.name ?? siteId}
          nowIso={nowIso}
          initialOverride={override.status}
          overrideUnavailable={!override.ok}
        />
      </div>
    );
  }

  if (slug === "appointments") {
    // THE PRE-VISIT SUMMARY sits above the appointment list, and this is where it
    // belongs rather than on a twelfth record tab: what the patient said was asked
    // BEFORE an appointment and is read BEFORE one, and a tab that exists for a
    // fifth of patients is a tab that mostly says "nothing here".
    //
    // WHAT THE VIEWER MAY READ IS DECIDED SERVER-SIDE, HERE. projectSummary takes
    // the session's role and returns `clinical: null` for a viewer who may not read
    // the symptom half, so those answers never enter the render tree at all rather
    // than being hidden with CSS. A null user is the unenforced pilot and reads as
    // permitted, matching every other guard in this codebase.
    //
    // A FAILED READ IS NOT AN ABSENCE. `null` from the catch means we could not
    // look, and the panel says so; an empty list means the patient has none, and
    // the panel renders nothing at all.
    const viewer = await getSessionUser();
    const previsit = await listResponsesForPatient([siteId], patient.id, 1).then(
      (rows) => ({ ok: true, rows }),
      () => ({ ok: false, rows: [] as TriageResponse[] }),
    );
    const latest = previsit.rows[0] ?? null;
    return (
      <div className="space-y-4">
        <PreVisitSummaryPanel
          failed={!previsit.ok}
          summary={latest ? projectSummary(latest, viewer?.role ?? null) : null}
        />
        <TabAppointments appointments={detail.appointments} reads={reads} />
      </div>
    );
  }

  if (slug === "recalls") {
    // Filtered in the query: a record opened all day must not read the whole site's
    // recall worklist to show at most two rows. The catch is kept, but it now REPORTS:
    // an empty list from a failed read used to print "this patient is not in the
    // recall worklist", which is a claim about the patient, not about the database.
    const recall = await listRecallTargets({
      siteIds: [siteId],
      dentallyPatientId: patient.id,
    }).then(
      (targets) => ({ ok: true, targets }),
      () => ({ ok: false, targets: [] as RecallTarget[] }),
    );
    const targets = recall.targets;
    const touchLists = await Promise.all(
      targets.map((t) => listRecallTouches(t.id).catch(() => [] as ReactivationTouch[])),
    );
    const touches: Record<string, ReactivationTouch[]> = {};
    targets.forEach((t, i) => {
      touches[t.id] = touchLists[i];
    });
    return (
      <TabRecalls
        derived={derived}
        targets={targets}
        touches={touches}
        nowIso={nowIso}
        failed={!recall.ok}
      />
    );
  }

  if (slug === "notes") {
    return (
      <TabNotes
        siteId={siteId}
        patientId={patient.id}
        dentallyNotes={detail.notes}
        reads={reads}
        nowIso={nowIso}
      />
    );
  }

  if (slug === "account") {
    return <TabAccount detail={detail} derived={derived} reads={reads} patientName={patient.name} />;
  }

  if (slug === "correspondence") {
    // getPatientCorrespondence reads all twelve platform message stores plus, when they
    // are switched on, Dentally's own SMS log, its documents and its email — and reports
    // WHICH of them threw. The tab needs that to tell "none were sent" from "some
    // sources are down" from "we know nothing" from "that Dentally read is not switched
    // on". A total failure returning null used to render as "no messages have been sent
    // to this patient from this platform", in writing, on a clinical record.
    //
    // The remembered layout is read HERE, server side, exactly as the diary reads its
    // density and column cookies — so the first paint is already the shape the reader
    // asked for and the list does not reshuffle under them after hydration.
    const [read, cookieJar] = await Promise.all([
      getPatientCorrespondence([siteId], patient.id, patient.name).catch(() => ({
        messages: [],
        timeline: { entries: [], undated: [] },
        failedSources: ["Message history"],
        totalSources: 1,
        dentally: "failed" as const,
        documents: "failed" as const,
        emails: "failed" as const,
        unreadableEmails: 0,
        dentallyComplete: true,
      })),
      cookies(),
    ]);
    return (
      <TabCorrespondence
        timeline={read.timeline}
        failedSources={read.failedSources}
        totalSources={read.totalSources}
        dentally={read.dentally}
        documents={read.documents}
        emails={read.emails}
        unreadableEmails={read.unreadableEmails}
        dentallyComplete={read.dentallyComplete}
        view={parseCorrespondenceView(cookieJar.get(CORRESPONDENCE_VIEW_COOKIE)?.value)}
        // A STRING, assembled here, with the document id appended per row on the client.
        // Handing the client component a function to build it would put a callback
        // across the RSC boundary — the crash this repo already shipped once.
        //
        // Null while the documents read is off, so the timeline renders no link rather
        // than one that would 404 on a route which refuses to read.
        documentHrefBase={
          read.documents === "ok"
            ? `/api/patient-documents?client=${encodeURIComponent(clientSlug)}` +
              `&siteId=${encodeURIComponent(siteId)}&patientId=${encodeURIComponent(patient.id)}`
            : null
        }
      />
    );
  }

  if (slug === "tasks") {
    // WHY the -WithHealth variant. The generator catches EACH module read internally,
    // so the plain generateTasks can never throw, so a `.then(reject)` guard here was
    // unreachable and every read failure - a total Supabase outage included - fell
    // through to "No open tasks for this patient", a claim about the patient printed on
    // an outage. generateTasksWithHealth reports how many sources threw, so a full OR a
    // partial failure now surfaces as a failed-read notice rather than a false "none".
    const generated = await generateTasksWithHealth({
      clientId: client.id,
      clientSlug,
      siteIds: [siteId],
      nowIso,
    }).catch(() => ({ tasks: [], failedSources: 1, totalSources: 1 }));
    // patientId is populated ONLY from a target's own id field, never from a name.
    const mine = generated.tasks.filter((t) => t.patientId === patient.id && t.status === "open");
    return <TabTasks tasks={mine} failed={generated.failedSources > 0} />;
  }

  // audit
  const audit = await listPatientAudit(siteId, patient.id).then(
    (entries) => ({ ok: true, entries }),
    () => ({ ok: false, entries: [] as PatientAuditEntry[] }),
  );
  return <TabAudit entries={audit.entries} failed={!audit.ok} />;
}

/**
 * The status override, with the read's own success reported rather than swallowed.
 *
 * getOverride THROWS on any database error (it does `if (error) throw error`), so a
 * connection blip, an RLS change or a key rotation is indistinguishable from "no
 * override is set" to a caller that only catches to null. On a suppression marker
 * those are opposite facts, and the safe-looking one is the wrong default.
 */
async function readOverride(
  siteId: string,
  patientId: string,
): Promise<{ ok: boolean; status: PatientAdminStatus | null }> {
  try {
    const override = await getOverride(siteId, patientId);
    return { ok: true, status: override?.status ?? null };
  } catch {
    return { ok: false, status: null };
  }
}
