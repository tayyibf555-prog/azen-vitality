import "server-only";

import { MOCK_AUDITS, MOCK_POLICIES, MOCK_TRAINING_RECORDS, MOCK_STAFF } from "@/lib/compliance/mock";
import { TRAINING_REQUIREMENTS } from "@/lib/compliance/knowledge";
import { listTargets as listNoshowTargets } from "@/lib/noshow/repository";
import { listSubmissions } from "@/lib/onboarding/repository";
import { listResponses } from "@/lib/smile-assessment/repository";
import { londonDateTimeLabel } from "@/lib/time/london";

import { orderNotifications, type NotificationContext } from "./logic";
import type { NotificationItem } from "./types";

// ---------------------------------------------------------------------------
// Notifications are a DERIVED feed: the things the owner / team should act on now,
// pulled together from existing module data and computed on read. There is no new
// event store — exactly like the Daily brief and the Task queue.
//
// Resilience mirrors those two: EVERY source is wrapped in its own safe() builder
// so one failing or empty module never breaks the whole feed. The compliance
// source is pure mock (deterministic); the onboarding + smile-assessment sources
// read the database, so they degrade to [] on any error.
//
// An email digest is intentionally out of scope here: the Daily brief already
// emails the morning action list. This is the in-app feed only.
// ---------------------------------------------------------------------------

export interface BuildNotificationsContext {
  clientId: string;
  clientSlug: string;
  siteIds: string[];
}

/** A safe source: run the loader, fall back to [] on any error. */
async function safe(load: () => Promise<NotificationItem[]>): Promise<NotificationItem[]> {
  try {
    return await load();
  } catch {
    return [];
  }
}

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

// ---------------------------------------------------------------------------
// Source builders. Each returns NotificationItem[] (possibly empty).
// ---------------------------------------------------------------------------

/**
 * Compliance: every breached item (overdue audit, missing policy, expired
 * training) becomes a high notification; due-soon items become medium. Pure mock
 * state, so the ids and `at` are deterministic (we anchor `at` to each item's
 * due/expiry date). Stable ids `compliance:<itemId>`.
 */
function complianceNotifications(slug: string): NotificationItem[] {
  const href = `/c/${slug}/compliance`;
  const out: NotificationItem[] = [];

  for (const a of MOCK_AUDITS) {
    if (a.status !== "overdue" && a.status !== "due_soon") continue;
    const overdue = a.status === "overdue";
    out.push({
      id: `compliance:${a.id}`,
      type: "compliance",
      urgency: overdue ? "high" : "medium",
      title: `${overdue ? "Overdue" : "Due soon"}: ${a.name}`,
      detail: overdue
        ? `${a.regulation} audit is past its due date (${dueDateLabel(a.dueAt)}). Clear this to protect CQC readiness.`
        : `${a.regulation} audit is due on ${dueDateLabel(a.dueAt)}.`,
      at: a.dueAt,
      href,
    });
  }

  for (const p of MOCK_POLICIES) {
    if (p.status !== "missing" && p.status !== "review_due") continue;
    const missing = p.status === "missing";
    out.push({
      id: `compliance:${p.id}`,
      type: "compliance",
      urgency: missing ? "high" : "medium",
      title: `${missing ? "Missing" : "Review due"}: ${p.name}`,
      detail: missing
        ? `No ${p.category.toLowerCase()} document on file. Put this policy in place.`
        : `${p.category} policy last reviewed ${p.lastReviewedAt ? dueDateLabel(p.lastReviewedAt) : "some time ago"}. A review is due.`,
      // Missing policies have no review date; anchor to a fixed past instant so
      // they still sort sensibly (high urgency carries them to the top regardless).
      at: p.lastReviewedAt ?? "2026-01-01T00:00:00.000Z",
      href,
    });
  }

  const staffById = new Map(MOCK_STAFF.map((s) => [s.id, s]));
  const reqById = new Map(TRAINING_REQUIREMENTS.map((r) => [r.id, r]));
  for (const r of MOCK_TRAINING_RECORDS) {
    if (r.status !== "overdue" && r.status !== "due_soon") continue;
    const overdue = r.status === "overdue";
    const staffName = staffById.get(r.staffId)?.name ?? "A staff member";
    const reqName = reqById.get(r.requirementId)?.name ?? "Mandatory training";
    const expiry = r.expiresAt ? dueDateLabel(r.expiresAt) : "soon";
    out.push({
      id: `compliance:${r.id}`,
      type: "compliance",
      urgency: overdue ? "high" : "medium",
      title: `${overdue ? "Overdue" : "Due soon"}: ${staffName} / ${reqName}`,
      detail: overdue
        ? `Mandatory training expired ${expiry}. Book a refresher.`
        : `Mandatory training expires ${expiry}.`,
      at: r.expiresAt ?? "2026-01-01T00:00:00.000Z",
      href,
    });
  }

  return out;
}

/**
 * No-show risk: high-risk upcoming appointments still being defended (status
 * 'scheduled') become high notifications, one per appointment. Reads the DB, so
 * the whole builder is wrapped in safe() above. Stable ids `no_show:<apptId>`.
 */
async function noshowNotifications(ctx: BuildNotificationsContext): Promise<NotificationItem[]> {
  const targets = await listNoshowTargets({
    siteIds: ctx.siteIds,
    statuses: ["scheduled"],
    riskBands: ["high"],
  });
  const href = `/c/${ctx.clientSlug}/no-show-defence`;
  return targets.map((t) => ({
    id: `no_show:${t.appointmentId}`,
    type: "no_show" as const,
    urgency: "high" as const,
    title: `High no-show risk: ${t.patientName}`,
    detail: `Most likely to miss their ${londonDateTimeLabel(t.appointmentStartAt)} appointment. Confirm them to protect the diary.`,
    at: t.appointmentStartAt,
    href,
  }));
}

/**
 * Onboarding: new patient onboarding submissions awaiting review roll up into a
 * single medium notification ("N new submissions to review"). One stable id
 * (`onboarding:new`) so it dedupes cleanly and a dismiss sticks until the next
 * batch. Reads the DB -> safe().
 */
async function onboardingNotifications(ctx: BuildNotificationsContext): Promise<NotificationItem[]> {
  const submissions = await listSubmissions(ctx.clientId);
  const newOnes = submissions.filter((s) => s.status === "new");
  if (newOnes.length === 0) return [];
  // Newest submission anchors recency.
  const newest = newOnes.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
  return [
    {
      id: "onboarding:new",
      type: "onboarding",
      urgency: "medium",
      title: `${newOnes.length} new patient onboarding submission${newOnes.length === 1 ? "" : "s"} to review`,
      detail: "New patients have completed the onboarding form. Review the details and register them.",
      at: newest.createdAt,
      href: `/c/${ctx.clientSlug}/onboarding`,
    },
  ];
}

/**
 * Enquiries: recent high-band Smile Assessment responses that have NOT already
 * been bridged into Speed-to-lead are new high-intent enquiries worth a fast look.
 * One high notification each. Stable ids `lead:<responseId>`. Reads the DB -> safe().
 */
async function leadNotifications(ctx: BuildNotificationsContext): Promise<NotificationItem[]> {
  const responses = await listResponses({ siteIds: ctx.siteIds, bands: ["high"], limit: 50 });
  return responses
    .filter((r) => r.leadId === null)
    .map((r) => ({
      id: `lead:${r.id}`,
      type: "lead" as const,
      urgency: "high" as const,
      title: `New high-intent enquiry: ${r.firstName}`,
      detail: r.treatmentInterest
        ? `High-intent ${r.treatmentInterest} enquiry from the smile assessment. Contact them first.`
        : "High-intent enquiry from the smile assessment. Contact them first.",
      at: r.createdAt,
      href: `/c/${ctx.clientSlug}/smile-assessment`,
    }));
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Build the notifications feed for a client: aggregate every source via resilient
 * safe() builders, then dedupe + sort (urgency desc, then most recent) through the
 * pure `orderNotifications`. Always returns an array, never throws.
 */
export async function buildNotifications(
  ctx: BuildNotificationsContext,
): Promise<NotificationItem[]> {
  const groups = await Promise.all([
    safe(async () => complianceNotifications(ctx.clientSlug)),
    safe(() => noshowNotifications(ctx)),
    safe(() => onboardingNotifications(ctx)),
    safe(() => leadNotifications(ctx)),
  ]);

  const orderCtx: NotificationContext = {};
  return orderNotifications(groups.flat(), orderCtx);
}
