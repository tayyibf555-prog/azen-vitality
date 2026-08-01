import { notFound } from "next/navigation";
import { getClient, getSite } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { getPatientRecordInScope } from "@/lib/patient/record";
import { getOverride } from "@/lib/patient-status/repository";
import { numberHealthFor, type NumberHealth } from "@/lib/messaging/number-health";
import { getThreadForPatient } from "@/lib/inbox/repository";
import { listPatientAudit, type PatientAuditEntry } from "@/lib/patient/profile-audit";
import { listTargets as listRecallTargets, listTouches as listRecallTouches } from "@/lib/recall/repository";
import { generateTasks } from "@/lib/task-queue/generate";
import type { Task } from "@/lib/task-queue/types";
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
import { TabRecalls } from "./tab-recalls";
import { TabTasks } from "./tab-tasks";
import { UnavailablePanel } from "./unavailable-panel";
import { RecordSummary } from "./record-summary";

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
 * Medical, Chart and Perio render UnavailablePanel directly rather than through three
 * one-line wrapper files: the panel already takes the slug and reads every word of its
 * copy from lib/patient/tabs.ts, so a wrapper would add a file and no behaviour.
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

  if (slug === "medical" || slug === "chart" || slug === "perio") {
    return <UnavailablePanel slug={slug} />;
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
    return <TabAppointments appointments={detail.appointments} reads={reads} />;
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
    // getThreadForPatient reports how many of its seven stores threw, so the tab can
    // tell "none were sent" from "some sources are down" from "we know nothing".
    // A total failure returning null used to render as "no messages have been sent to
    // this patient from this platform", in writing, on a clinical record.
    const read = await getThreadForPatient([siteId], patient.id).catch(() => ({
      thread: null,
      failedSources: 1,
      totalSources: 1,
    }));
    return (
      <TabCorrespondence
        thread={read.thread}
        failedSources={read.failedSources}
        totalSources={read.totalSources}
      />
    );
  }

  if (slug === "tasks") {
    // The generator is resilient per module already; this catch covers a total
    // failure so one dead module never blanks the record. It reports, because
    // "no open tasks for this patient" is a claim and an outage is not.
    const generated = await generateTasks({
      clientId: client.id,
      clientSlug,
      siteIds: [siteId],
      nowIso,
    }).then(
      (tasks) => ({ ok: true, tasks }),
      () => ({ ok: false, tasks: [] as Task[] }),
    );
    // patientId is populated ONLY from a target's own id field, never from a name.
    const mine = generated.tasks.filter((t) => t.patientId === patient.id && t.status === "open");
    return <TabTasks tasks={mine} failed={!generated.ok} />;
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
