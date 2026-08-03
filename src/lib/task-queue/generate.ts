import "server-only";
import { listLeads } from "@/lib/speed-to-lead/repository";
import { listTargets as listRecallTargets } from "@/lib/recall/repository";
import { listTargets as listReactivationTargets } from "@/lib/reactivation/repository";
import { listOpportunities } from "@/lib/coordinator/repository";
import { listTargets as listNoshowTargets } from "@/lib/noshow/repository";
import { listCaptures } from "@/lib/after-hours/repository";
import { afterHoursTaskCopy, captureTiming } from "@/lib/after-hours/call-outcome";
import { getSiteById } from "@/lib/after-hours/hours";
import { listResponses } from "@/lib/smile-assessment/repository";
import { londonDateTimeLabel } from "@/lib/time/london";
import { computePriority, applyOverlay } from "./logic";
import { getOverlayMap } from "./repository";
import type { CandidateTask, Task, TaskOverlayState } from "./types";

// The Task Queue is computed on read: each module's actionable items are mapped to
// CandidateTasks, then the persisted overlay (done/snoozed/assigned) is applied.
// Mirrors the Daily brief's resilient compose pattern: every module read is wrapped
// in safe() so one slow/failing module never blanks the whole queue.

export interface TaskQueueContext {
  clientId: string;
  clientSlug: string;
  siteIds: string[];
  nowIso: string;
}

function overdueHint(days: number): string {
  if (days > 0) return `${days} day${days === 1 ? "" : "s"} overdue`;
  if (days < 0) return `due in ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`;
  return "due today";
}

function apptHint(iso: string): string {
  return londonDateTimeLabel(iso);
}

// --- Per-module candidate builders -----------------------------------------

async function speedToLeadCandidates(ctx: TaskQueueContext): Promise<CandidateTask[]> {
  const leads = await listLeads({ siteIds: ctx.siteIds, stages: ["new", "contacted", "qualifying"] });
  return leads.map((l) => ({
    key: `speed-to-lead:${l.id}:contact`,
    module: "speed-to-lead" as const,
    kind: "contact_lead" as const,
    title: `Contact ${l.name}`,
    subtitle: l.treatmentInterest ? `${l.treatmentInterest} enquiry` : "New enquiry",
    patientName: l.name,
    // A lead is not yet a Dentally patient, and lead.id is our own uuid. Null, never
    // a name match.
    patientId: null,
    siteId: l.siteId,
    priority: computePriority("contact_lead"),
    dueHint: l.firstResponseAt ? "awaiting reply" : "not yet contacted",
    href: `/c/${ctx.clientSlug}/speed-to-lead`,
  }));
}

async function recallCandidates(ctx: TaskQueueContext): Promise<CandidateTask[]> {
  const targets = await listRecallTargets({ siteIds: ctx.siteIds, statuses: ["due", "in_cadence"] });
  return targets.map((t) => ({
    key: `recall:${t.id}:chase`,
    module: "recall" as const,
    kind: "chase_recall" as const,
    title: `${t.recallType === "hygienist" ? "Hygiene" : "Dentist"} recall: ${t.patientName}`,
    subtitle: overdueHint(t.overdueDays),
    patientName: t.patientName,
    // From the target's OWN id field (which is also embedded in `t.id` as
    // `${siteId}:${dentallyPatientId}:${recallType}`). Never from patientName.
    patientId: t.dentallyPatientId,
    siteId: t.siteId,
    priority: computePriority("chase_recall", { overdueDays: t.overdueDays }),
    dueHint: overdueHint(t.overdueDays),
    href: `/c/${ctx.clientSlug}/recall`,
  }));
}

async function reactivationCandidates(ctx: TaskQueueContext): Promise<CandidateTask[]> {
  const targets = await listReactivationTargets({ siteIds: ctx.siteIds, statuses: ["dormant", "in_cadence"] });
  return targets.map((t) => ({
    key: `reactivation:${t.id}:reactivate`,
    module: "reactivation" as const,
    kind: "reactivate" as const,
    title: `Reactivate ${t.patientName}`,
    subtitle: t.recoverableValue > 0 ? `£${t.recoverableValue} recoverable` : t.reason.replace(/_/g, " "),
    patientName: t.patientName,
    // From the target's OWN id field (also embedded in `t.id` as
    // `${siteId}:${dentallyPatientId}`). Never from patientName.
    patientId: t.dentallyPatientId,
    siteId: t.siteId,
    priority: computePriority("reactivate", { recoverableValue: t.recoverableValue }),
    dueHint: null,
    href: `/c/${ctx.clientSlug}/reactivation`,
  }));
}

async function coordinatorCandidates(ctx: TaskQueueContext): Promise<CandidateTask[]> {
  const opps = await listOpportunities({ siteIds: ctx.siteIds, statuses: ["accepted", "in_progress"] });
  return opps.map((o) => ({
    key: `coordinator:${o.id}:follow-up`,
    module: "coordinator" as const,
    kind: "follow_up_plan" as const,
    title: `Follow up ${o.patientName}: ${o.treatment}`,
    subtitle: o.amountOutstanding > 0 ? `£${o.amountOutstanding} outstanding` : "in progress",
    patientName: o.patientName,
    // treatment_opportunity is keyed by an opaque uuid and carries no Dentally patient
    // id, so this task cannot be attributed to a patient. Null, never a name match.
    patientId: null,
    siteId: o.siteId,
    priority: computePriority("follow_up_plan", { recoverableValue: o.amountOutstanding }),
    dueHint: null,
    href: `/c/${ctx.clientSlug}/treatment-coordinator`,
  }));
}

async function noshowCandidates(ctx: TaskQueueContext): Promise<CandidateTask[]> {
  const targets = await listNoshowTargets({ siteIds: ctx.siteIds, statuses: ["scheduled"], riskBands: ["high"] });
  return targets.map((t) => ({
    key: `noshow:${t.id}:confirm`,
    module: "noshow" as const,
    kind: "confirm_appt" as const,
    title: `Confirm ${t.patientName}`,
    subtitle: `High no-show risk, ${apptHint(t.appointmentStartAt)}`,
    patientName: t.patientName,
    // From the target's OWN id field (also embedded in `t.id` as
    // `${siteId}:${dentallyPatientId}:${appointmentId}`). Never from patientName.
    patientId: t.dentallyPatientId,
    siteId: t.siteId,
    priority: computePriority("confirm_appt", { riskScore: t.riskScore }),
    dueHint: apptHint(t.appointmentStartAt),
    href: `/c/${ctx.clientSlug}/no-show-defence`,
  }));
}

async function afterHoursCandidates(ctx: TaskQueueContext): Promise<CandidateTask[]> {
  const captures = await listCaptures({ siteIds: ctx.siteIds, statuses: ["new"] });
  return captures.map((c) => {
    // Whether this call landed out of hours or as daytime overflow is DERIVED here
    // rather than stored: capturedAt plus the site's opening hours already answer
    // it, and a new column would leave every existing row unlabelled. Putting the
    // out-of-hours wording on a 2pm overflow call misleads whoever picks it up.
    const copy = afterHoursTaskCopy(captureTiming(c.capturedAt, getSiteById(c.siteId)));
    return {
      key: `after-hours:${c.id}:callback`,
      module: "after-hours" as const,
      kind: "after_hours_callback" as const,
      title: `Call back ${c.patientName}`,
      subtitle: c.body ? c.body.slice(0, 70) : copy.subtitle,
      patientName: c.patientName,
      // From the capture's OWN id field: the voice and inbound webhooks resolve the
      // caller through identifyByPhone and store the Dentally id on the row, so an
      // identified caller's callback belongs on their record. Null for an unknown
      // number. Never a name match.
      patientId: c.dentallyPatientId,
      siteId: c.siteId,
      priority: computePriority("after_hours_callback"),
      dueHint: copy.dueHint,
      href: `/c/${ctx.clientSlug}/after-hours`,
    };
  });
}

async function smileAssessmentCandidates(ctx: TaskQueueContext): Promise<CandidateTask[]> {
  const responses = await listResponses({ siteIds: ctx.siteIds, bands: ["high"] });
  // Only high scorers NOT already bridged into Speed-to-lead need a manual look.
  return responses
    .filter((r) => r.leadId === null)
    .map((r) => ({
      key: `smile-assessment:${r.id}:action`,
      module: "smile-assessment" as const,
      kind: "action_assessment" as const,
      title: `Review ${r.firstName}'s assessment`,
      subtitle: r.treatmentInterest ? `High intent, ${r.treatmentInterest}` : "High intent",
      patientName: r.firstName,
      // A smile-assessment response is an enquiry keyed by our own uuid, with a first
      // name and no Dentally patient id. Null, never a name match.
      patientId: null,
      siteId: r.siteId,
      priority: computePriority("action_assessment"),
      dueHint: "high intent",
      href: `/c/${ctx.clientSlug}/smile-assessment`,
    }));
}

// --- Aggregate --------------------------------------------------------------

/**
 * The generated queue AND how much of it could be read.
 *
 * `failedSources` and `totalSources` are what let the patient record's Tasks tab tell
 * "this patient has no open work" (a claim about the patient) apart from "we could not
 * read some of the work" (a claim about the network). Every module read is caught HERE,
 * so a caller that wants that distinction cannot rely on the aggregate throwing.
 */
export interface TaskQueueResult {
  tasks: Task[];
  /** How many of the sources (seven modules plus the overlay) threw. */
  failedSources: number;
  totalSources: number;
}

// The seven module builders, caught INDIVIDUALLY so one dead module never blanks the
// queue and, critically, so the failure is COUNTED rather than swallowed. The old
// `safe()` helper returned [] on a throw with no trace, which is why a total Supabase
// outage rendered as "No open tasks for this patient" on the record instead of a
// failed-read notice.
const CANDIDATE_BUILDERS: readonly ((ctx: TaskQueueContext) => Promise<CandidateTask[]>)[] = [
  speedToLeadCandidates,
  recallCandidates,
  reactivationCandidates,
  coordinatorCandidates,
  noshowCandidates,
  afterHoursCandidates,
  smileAssessmentCandidates,
];

export async function generateTasksWithHealth(ctx: TaskQueueContext): Promise<TaskQueueResult> {
  let failedSources = 0;
  const groups = await Promise.all(
    CANDIDATE_BUILDERS.map(async (build) => {
      try {
        return await build(ctx);
      } catch {
        failedSources += 1;
        return [] as CandidateTask[];
      }
    }),
  );
  const candidates = groups.flat();

  let overlays: Map<string, TaskOverlayState>;
  try {
    overlays = await getOverlayMap(ctx.clientId);
  } catch {
    failedSources += 1;
    overlays = new Map();
  }
  return {
    tasks: applyOverlay(candidates, overlays, ctx.nowIso),
    failedSources,
    totalSources: CANDIDATE_BUILDERS.length + 1,
  };
}

/** The queue alone, for callers that do not surface read health (the queue page and
 *  the dashboard count). Behaviour is unchanged: each source is still caught and a
 *  failure still yields an empty group rather than throwing. */
export async function generateTasks(ctx: TaskQueueContext): Promise<Task[]> {
  return (await generateTasksWithHealth(ctx)).tasks;
}
