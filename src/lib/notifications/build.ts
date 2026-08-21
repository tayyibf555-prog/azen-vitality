import "server-only";

import { listOpenAlerts } from "@/lib/anomaly/repository";
import { listTargets as listNoshowTargets } from "@/lib/noshow/repository";
import { countNewSubmissions } from "@/lib/onboarding/repository";
import { listResponses } from "@/lib/smile-assessment/repository";
import { isSystemEnabled } from "@/lib/systems/repository";
import { londonDateTimeLabel } from "@/lib/time/london";

import { orderNotifications, type NotificationContext } from "./logic";
import type { NotificationItem } from "./types";

// ---------------------------------------------------------------------------
// Notifications are a DERIVED feed: the things the owner / team should act on now,
// pulled together from existing module data and computed on read. There is no new
// event store — exactly like the Daily brief and the Task queue.
//
// Resilience: EVERY source is wrapped in its own safe() builder so one failing or
// empty module never breaks the whole feed. Every source reads the database (real),
// so each degrades to [] on any error. No fabricated items are produced: compliance
// notifications return once the practice's real compliance records are connected.
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

// ---------------------------------------------------------------------------
// Source builders. Each returns NotificationItem[] (possibly empty).
// ---------------------------------------------------------------------------

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
  // Head-count roll-up: never pull full submission rows (each carries the answers
  // jsonb) just to count and date the badge. Scoped to the view's sites so the
  // badge count matches the (scoped) worklist the notification links to.
  const { count, newestAt } = await countNewSubmissions(ctx.clientId, ctx.siteIds);
  if (count === 0 || !newestAt) return [];
  return [
    {
      id: "onboarding:new",
      type: "onboarding",
      urgency: "medium",
      title: `${count} new patient onboarding submission${count === 1 ? "" : "s"} to review`,
      detail: "New patients have completed the onboarding form. Review the details and register them.",
      at: newestAt,
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

/**
 * Proactive anomaly alerts. The ONE source here that is not recomputed on read:
 * the hourly pass (src/app/api/anomaly/sweep) already decided what it could
 * prove, wrote one row per condition, and this renders those rows verbatim.
 *
 * Rendering the stored sentence rather than recomposing it is the point. The
 * readings behind an alert are gone by the time anybody opens this page, and a
 * sentence rebuilt from whatever the tables say now would quietly change what
 * the practice was told without anybody deciding to change it.
 *
 * GATED ON THE SAME SWITCH THE PASS IS. 'anomaly-alerts' is default-off, so with
 * no toggle row this returns nothing — and switching the system off hides the
 * alerts it already raised rather than leaving residue on the screen, which
 * makes the flip a complete revert. isSystemEnabled fails CLOSED for a
 * default-off slug, so an unreadable toggle table also shows nothing.
 *
 * Stable ids `anomaly:<dedupe key>`, so the list's localStorage dismiss sticks
 * to the CONDITION: dismissing "takings are down" hides that condition, and it
 * comes back if the pass resolves it and later raises it again.
 */
async function anomalyNotifications(ctx: BuildNotificationsContext): Promise<NotificationItem[]> {
  if (!(await isSystemEnabled(ctx.clientId, "anomaly-alerts"))) return [];

  const alerts = await listOpenAlerts(ctx.clientId);
  return alerts.map((a) => ({
    id: `anomaly:${a.dedupeKey}`,
    type: "anomaly" as const,
    urgency: a.severity,
    // The feed's row is a title plus a detail; the alert is one sentence by
    // design. The severity word is the title so the row scans, and the sentence
    // itself is never split, truncated or reworded on its way to the screen.
    title: ALERT_TITLE[a.severity],
    detail: a.sentence,
    at: a.at,
    // Absent for a system with no worklist page yet, in which case the row
    // renders without a link rather than linking somewhere that proves nothing.
    ...(a.href ? { href: `/c/${ctx.clientSlug}/${a.href}` } : {}),
  }));
}

/** The row title. The sentence carries the substance; this is the scan line. */
const ALERT_TITLE: Record<"high" | "medium" | "low", string> = {
  high: "Needs a look now",
  medium: "Worth a look today",
  low: "Worth knowing",
};

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
    safe(() => anomalyNotifications(ctx)),
    safe(() => noshowNotifications(ctx)),
    safe(() => onboardingNotifications(ctx)),
    safe(() => leadNotifications(ctx)),
  ]);

  const orderCtx: NotificationContext = {};
  return orderNotifications(groups.flat(), orderCtx);
}
