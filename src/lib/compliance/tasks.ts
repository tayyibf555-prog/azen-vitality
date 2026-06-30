// Compliance -> Task Queue bridge (pure, no I/O).
//
// The Compliance section holds the practice's regulatory position: audits,
// policies and the staff training matrix. On its own that data only lives in the
// Compliance page. This module turns every item that needs attention into a
// CandidateTask in the EXACT shape the Task Queue generator produces, so overdue
// and due-soon compliance work shows up in the one prioritised worklist and can
// be claimed, snoozed or marked done like any other task.
//
// Pure and deterministic: it reads the static mock state and returns plain task
// objects. Keys are stable (`compliance:<itemId>`) so the persisted overlay
// (done/snooze/assign) sticks to the right item and the same item never
// duplicates across runs.

import { MOCK_AUDITS, MOCK_POLICIES, MOCK_TRAINING_RECORDS, MOCK_STAFF } from "./mock";
import { TRAINING_REQUIREMENTS } from "./knowledge";
import { computePriority } from "@/lib/task-queue/logic";
import type { CandidateTask } from "@/lib/task-queue/types";
import type { ComplianceStatus } from "./types";

/**
 * Overdue items get an urgency boost on top of their kind base; due_soon items
 * get none and sit in the medium band. Reusing the generator's `overdueDays`
 * lever keeps compliance priorities on the same scale as the rest of the queue
 * (overdueDays >= 56 saturates the +8 boost, so any overdue item gets the full
 * lift without depending on a real day count we do not always have).
 */
const OVERDUE_BOOST_DAYS = 56;

/** A short, plain-date label for a due date, e.g. "5 Jun 2026". Guards bad input. */
function dueDateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}

/** "Overdue" / "Due soon" lead-in for a title, from an attention status. */
function statusLead(status: ComplianceStatus | "missing" | "review_due"): string {
  return status === "overdue" || status === "missing" ? "Overdue" : "Due soon";
}

/** Priority for a compliance kind: full overdue boost for breached items. */
function priorityFor(
  kind: "compliance_audit" | "compliance_policy" | "compliance_training",
  overdue: boolean,
): number {
  return computePriority(kind, overdue ? { overdueDays: OVERDUE_BOOST_DAYS } : {});
}

function complianceHref(clientSlug: string): string {
  return `/c/${clientSlug}/compliance`;
}

export interface ComplianceTasksContext {
  clientSlug: string;
  /** First site id, used to satisfy CandidateTask.siteId (compliance is practice-wide). */
  siteId: string;
}

/**
 * Every overdue or due-soon audit becomes a task. Overdue audits (HTM 01-05,
 * fire risk assessment, etc.) are highest; due-soon audits sit a band lower.
 */
function auditTasks(ctx: ComplianceTasksContext): CandidateTask[] {
  return MOCK_AUDITS.filter((a) => a.status === "overdue" || a.status === "due_soon").map((a) => {
    const overdue = a.status === "overdue";
    const owner = a.ownerRole || "practice manager";
    return {
      key: `compliance:${a.id}`,
      module: "compliance" as const,
      kind: "compliance_audit" as const,
      title: `${statusLead(a.status)}: ${a.name}`,
      subtitle: `${a.regulation} / ${owner} / due ${dueDateLabel(a.dueAt)}`,
      patientName: a.name,
      siteId: ctx.siteId,
      priority: priorityFor("compliance_audit", overdue),
      dueHint: overdue ? `overdue since ${dueDateLabel(a.dueAt)}` : `due ${dueDateLabel(a.dueAt)}`,
      href: complianceHref(ctx.clientSlug),
    };
  });
}

/**
 * Every missing or review-due policy becomes a task. A missing required policy
 * (e.g. the business continuity plan) is treated as overdue; a review-due policy
 * is the gentler due-soon band.
 */
function policyTasks(ctx: ComplianceTasksContext): CandidateTask[] {
  return MOCK_POLICIES.filter((p) => p.status === "missing" || p.status === "review_due").map(
    (p) => {
      const missing = p.status === "missing";
      const lead = missing ? "Missing" : "Review due";
      const detail = missing
        ? `${p.category} policy / no document on file`
        : `${p.category} policy / last reviewed ${p.lastReviewedAt ? dueDateLabel(p.lastReviewedAt) : "unknown"}`;
      return {
        key: `compliance:${p.id}`,
        module: "compliance" as const,
        kind: "compliance_policy" as const,
        title: `${lead}: ${p.name}`,
        subtitle: detail,
        patientName: p.name,
        siteId: ctx.siteId,
        priority: priorityFor("compliance_policy", missing),
        dueHint: missing ? "not in place" : "review due",
        href: complianceHref(ctx.clientSlug),
      };
    },
  );
}

/**
 * Every overdue or due-soon training record becomes a task, with the staff
 * member and requirement names resolved so the row reads like a real action
 * (e.g. "Overdue: Sophie Kelman / Medical emergencies and CPR").
 */
function trainingTasks(ctx: ComplianceTasksContext): CandidateTask[] {
  const staffById = new Map(MOCK_STAFF.map((s) => [s.id, s]));
  const reqById = new Map(TRAINING_REQUIREMENTS.map((r) => [r.id, r]));

  return MOCK_TRAINING_RECORDS.filter(
    (r) => r.status === "overdue" || r.status === "due_soon",
  ).map((r) => {
    const overdue = r.status === "overdue";
    const staffName = staffById.get(r.staffId)?.name ?? "A staff member";
    const reqName = reqById.get(r.requirementId)?.name ?? "Mandatory training";
    const expiry = r.expiresAt ? dueDateLabel(r.expiresAt) : "soon";
    return {
      key: `compliance:${r.id}`,
      module: "compliance" as const,
      kind: "compliance_training" as const,
      title: `${statusLead(r.status)}: ${staffName} / ${reqName}`,
      subtitle: overdue
        ? `Mandatory training expired ${expiry}`
        : `Mandatory training expires ${expiry}`,
      patientName: `${staffName} ${reqName}`,
      siteId: ctx.siteId,
      priority: priorityFor("compliance_training", overdue),
      dueHint: overdue ? `expired ${expiry}` : `expires ${expiry}`,
      href: complianceHref(ctx.clientSlug),
    };
  });
}

/**
 * Build the full set of compliance candidate tasks: one per attention-needing
 * audit, policy and training record. Pure and deterministic.
 */
export function complianceTasks(ctx: ComplianceTasksContext): CandidateTask[] {
  return [...auditTasks(ctx), ...policyTasks(ctx), ...trainingTasks(ctx)];
}
