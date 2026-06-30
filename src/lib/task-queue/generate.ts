import "server-only";
import { listLeads } from "@/lib/speed-to-lead/repository";
import { listTargets as listRecallTargets } from "@/lib/recall/repository";
import { listTargets as listReactivationTargets } from "@/lib/reactivation/repository";
import { listOpportunities } from "@/lib/coordinator/repository";
import { listTargets as listNoshowTargets } from "@/lib/noshow/repository";
import { listCaptures } from "@/lib/after-hours/repository";
import { listResponses } from "@/lib/smile-assessment/repository";
import { complianceTasks } from "@/lib/compliance/tasks";
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

async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
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
    siteId: t.siteId,
    priority: computePriority("confirm_appt", { riskScore: t.riskScore }),
    dueHint: apptHint(t.appointmentStartAt),
    href: `/c/${ctx.clientSlug}/no-show-defence`,
  }));
}

async function afterHoursCandidates(ctx: TaskQueueContext): Promise<CandidateTask[]> {
  const captures = await listCaptures({ siteIds: ctx.siteIds, statuses: ["new"] });
  return captures.map((c) => ({
    key: `after-hours:${c.id}:callback`,
    module: "after-hours" as const,
    kind: "after_hours_callback" as const,
    title: `Call back ${c.patientName}`,
    subtitle: c.body ? c.body.slice(0, 70) : "Tried to reach the practice out of hours",
    patientName: c.patientName,
    siteId: c.siteId,
    priority: computePriority("after_hours_callback"),
    dueHint: "out of hours",
    href: `/c/${ctx.clientSlug}/after-hours`,
  }));
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
      siteId: r.siteId,
      priority: computePriority("action_assessment"),
      dueHint: "high intent",
      href: `/c/${ctx.clientSlug}/smile-assessment`,
    }));
}

async function complianceCandidates(ctx: TaskQueueContext): Promise<CandidateTask[]> {
  // Compliance is a pure, practice-wide source (no per-site read): every overdue
  // or due-soon audit, policy and training record becomes a task. siteId is the
  // first site so the task carries a valid site, matching CandidateTask's shape.
  return complianceTasks({ clientSlug: ctx.clientSlug, siteId: ctx.siteIds[0] ?? "" });
}

// --- Aggregate --------------------------------------------------------------

export async function generateTasks(ctx: TaskQueueContext): Promise<Task[]> {
  const groups = await Promise.all([
    safe(() => speedToLeadCandidates(ctx)),
    safe(() => recallCandidates(ctx)),
    safe(() => reactivationCandidates(ctx)),
    safe(() => coordinatorCandidates(ctx)),
    safe(() => noshowCandidates(ctx)),
    safe(() => afterHoursCandidates(ctx)),
    safe(() => smileAssessmentCandidates(ctx)),
    safe(() => complianceCandidates(ctx)),
  ]);
  const candidates = groups.flat();

  let overlays: Map<string, TaskOverlayState>;
  try {
    overlays = await getOverlayMap(ctx.clientId);
  } catch {
    overlays = new Map();
  }
  return applyOverlay(candidates, overlays, ctx.nowIso);
}
