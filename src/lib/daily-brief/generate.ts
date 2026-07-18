import "server-only";

import { listAppointments, listOutstanding } from "@/lib/dentally/read";
import { listTargets as listNoshowTargets } from "@/lib/noshow/repository";
import { listTargets as listRecallTargets } from "@/lib/recall/repository";
import { listTargets as listReactivationTargets } from "@/lib/reactivation/repository";
import { listOpportunities } from "@/lib/coordinator/repository";
import { listCaptures } from "@/lib/after-hours/repository";

import { londonDayKey } from "@/lib/time/london";

import type { BriefContext, BriefItem, BriefLine, BriefSection, DailyBrief } from "./types";

// ---------------------------------------------------------------------------
// The daily brief reads the diary every morning and hands each role a
// prioritised action list. It is compute-on-read: it composes the existing
// module read functions and never writes a snapshot.
//
// Resilience is a hard requirement. A missing table or an empty module must
// never break the whole brief, so EVERY external read is wrapped in its own
// try/catch and degrades to empty. The brief always renders.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const PRIORITY_RANK: Record<BriefItem["priority"], number> = { high: 0, medium: 1, low: 2 };
const HIGH_VALUE_OUTSTANDING = 1000; // GBP threshold for "large balance"

/** YYYY-MM-DD for the Europe/London calendar day of an instant. */
function dayKey(d: Date): string {
  return londonDayKey(d);
}

/** Whether an ISO instant falls on the given Europe/London day. */
function isOnDay(iso: string, day: string): boolean {
  return typeof iso === "string" && londonDayKey(new Date(iso)) === day;
}

/** A safe read: run the loader, fall back to the given empty value on any error. */
async function safe<T>(load: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await load();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Section builders. Each returns a BriefSection (possibly with no items).
// ---------------------------------------------------------------------------

interface BuildState {
  appointmentsToday: number;
}

async function buildDiarySection(ctx: BriefContext, state: BuildState): Promise<BriefSection> {
  const today = dayKey(ctx.now);
  const appts = await safe(() => listAppointments(ctx.siteIds, { from: today, to: today }), []);

  const gaps = appts.filter((a) => a.state === "cancelled" || a.state === "did_not_attend").length;
  const booked = appts.length - gaps;
  // The headline count is the booked figure, matching the "X booked in" body line
  // (don't inflate it with cancellations / did-not-attends).
  state.appointmentsToday = booked;

  const items: BriefLine[] = [];
  if (appts.length > 0) {
    items.push({
      title: `${appts.length} appointment${appts.length === 1 ? "" : "s"} today`,
      detail:
        gaps > 0
          ? `${booked} booked in, ${gaps} gap${gaps === 1 ? "" : "s"} to fill from cancellations.`
          : `${booked} booked in across your sites.`,
      priority: gaps > 0 ? "medium" : "low",
      count: appts.length,
      // The old /today module folded into Home; the Calendar is now the full
      // diary destination, so deep-link there (never at the /today redirect).
      href: "calendar",
    });
  }
  return { key: "diary", title: "Today's diary", items };
}

async function buildNoshowSection(ctx: BriefContext): Promise<BriefSection> {
  const today = dayKey(ctx.now);
  const tomorrow = dayKey(new Date(ctx.now.getTime() + DAY_MS));
  const targets = await safe(
    () => listNoshowTargets({ siteIds: ctx.siteIds, statuses: ["scheduled"], riskBands: ["high"] }),
    [],
  );
  const soon = targets.filter(
    (t) => isOnDay(t.appointmentStartAt, today) || isOnDay(t.appointmentStartAt, tomorrow),
  );

  const items: BriefLine[] = [];
  if (soon.length > 0) {
    items.push({
      title: `${soon.length} high-risk appointment${soon.length === 1 ? "" : "s"} to confirm`,
      detail: "These patients are most likely to miss. Confirm them today to protect the diary.",
      priority: "high",
      count: soon.length,
      href: "no-show-defence",
    });
  }
  return { key: "noshow", title: "No-show risks today", items };
}

async function buildArrivingValueSection(ctx: BriefContext): Promise<BriefSection> {
  const today = dayKey(ctx.now);
  // Independent reads, fetched concurrently (the appointments call is usually a
  // request-memo hit, but a cold one must not serialise in front of the plans).
  const [appts, opps] = await Promise.all([
    safe(() => listAppointments(ctx.siteIds, { from: today, to: today }), []),
    safe(() => listOpportunities({ siteIds: ctx.siteIds, statuses: ["accepted", "in_progress"] }), []),
  ]);

  // Cross-reference: patients with an open opportunity who have an appointment
  // today. Match on the patient name present on both records (the diary read
  // does not expose a stable patient id, so name within a site is the join).
  const todayNames = new Set(
    appts.map((a) => `${a.siteId}::${a.patientName.trim().toLowerCase()}`),
  );
  const arriving = opps.filter((o) =>
    todayNames.has(`${o.siteId}::${o.patientName.trim().toLowerCase()}`),
  );

  const items: BriefLine[] = [];
  if (arriving.length > 0) {
    const totalValue = arriving.reduce((sum, o) => sum + o.plannedValue, 0);
    const top = [...arriving].sort((a, b) => b.plannedValue - a.plannedValue).slice(0, 3);
    for (const o of top) {
      items.push({
        title: `${o.patientName} is in today`,
        detail: `Open ${o.treatment} plan. A good moment to move the next step along in person.`,
        priority: "high",
        value: o.plannedValue,
        href: "treatment-coordinator",
      });
    }
    if (arriving.length > top.length) {
      items.unshift({
        title: `${arriving.length} high-value patients arriving today`,
        detail: "Patients with open treatment plans who are already in the diary.",
        priority: "high",
        count: arriving.length,
        value: totalValue,
        href: "treatment-coordinator",
      });
    }
  }
  return { key: "arriving", title: "High-value treatment arriving today", items };
}

async function buildChaseSection(ctx: BriefContext): Promise<BriefSection> {
  // Three independent reads, fetched concurrently: serialising them put two
  // needless round trips on the Home page's critical path.
  const [recall, reactivation, opps] = await Promise.all([
    safe(() => listRecallTargets({ siteIds: ctx.siteIds, statuses: ["due", "in_cadence"] }), []),
    safe(
      () => listReactivationTargets({ siteIds: ctx.siteIds, statuses: ["dormant", "in_cadence"] }),
      [],
    ),
    safe(() => listOpportunities({ siteIds: ctx.siteIds, statuses: ["accepted", "in_progress"] }), []),
  ]);

  const items: BriefLine[] = [];
  if (recall.length > 0) {
    items.push({
      title: `${recall.length} recall${recall.length === 1 ? "" : "s"} to chase`,
      detail: "Patients due back in who have not booked yet.",
      priority: "medium",
      count: recall.length,
      href: "recall",
    });
  }
  if (reactivation.length > 0) {
    const value = reactivation.reduce((sum, t) => sum + t.recoverableValue, 0);
    items.push({
      title: `${reactivation.length} lapsed patient${reactivation.length === 1 ? "" : "s"} to revive`,
      detail: "Dormant patients and unfinished plans worth bringing back.",
      priority: "medium",
      count: reactivation.length,
      value: value > 0 ? value : undefined,
      href: "reactivation",
    });
  }
  if (opps.length > 0) {
    const value = opps.reduce((sum, o) => sum + o.amountOutstanding, 0);
    items.push({
      title: `${opps.length} treatment plan${opps.length === 1 ? "" : "s"} to follow up`,
      detail: "Accepted but incomplete treatment to re-present and book the next step.",
      priority: "high",
      count: opps.length,
      value: value > 0 ? value : undefined,
      href: "treatment-coordinator",
    });
  }
  return { key: "chase", title: "Who to chase", items };
}

async function buildOvernightSection(ctx: BriefContext): Promise<BriefSection> {
  const captures = await safe(
    () => listCaptures({ siteIds: ctx.siteIds, statuses: ["new"] }),
    [],
  );
  const items: BriefLine[] = [];
  if (captures.length > 0) {
    items.push({
      title: `${captures.length} missed call${captures.length === 1 ? "" : "s"} overnight`,
      detail: "Calls and messages that landed while you were closed. Follow up first thing.",
      priority: "high",
      count: captures.length,
      href: "after-hours",
    });
  }
  return { key: "overnight", title: "Overnight after-hours", items };
}

async function buildMoneySection(ctx: BriefContext): Promise<BriefSection> {
  const outstanding = await safe(() => listOutstanding(ctx.siteIds), []);
  const items: BriefLine[] = [];
  if (outstanding.length > 0) {
    const total = outstanding.reduce((sum, o) => sum + o.outstanding, 0);
    const large = outstanding.filter((o) => o.outstanding > HIGH_VALUE_OUTSTANDING);
    items.push({
      title: `${formatGbp(total)} outstanding across ${outstanding.length} account${outstanding.length === 1 ? "" : "s"}`,
      detail:
        large.length > 0
          ? `${large.length} balance${large.length === 1 ? "" : "s"} over ${formatGbp(HIGH_VALUE_OUTSTANDING)} to prioritise.`
          : "Balances owed on unpaid invoices.",
      priority: large.length > 0 ? "medium" : "low",
      count: outstanding.length,
      value: total,
      href: "payments",
    });
  }
  return { key: "money", title: "Money", items };
}

// ---------------------------------------------------------------------------
// Formatting (local, so the generator has no React/UI dependency).
// ---------------------------------------------------------------------------

function formatGbp(value: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

// ---------------------------------------------------------------------------
// Headline: the top prioritised items in the dashboard's BriefItem shape.
// ---------------------------------------------------------------------------

function lineToBriefItem(
  line: BriefLine,
  section: BriefSection,
  ctx: BriefContext,
  index: number,
): BriefItem {
  const metric: BriefItem["metric"] =
    section.key === "money" || line.value !== undefined
      ? "revenue"
      : section.key === "noshow"
        ? "risk"
        : section.key === "overnight"
          ? "time"
          : "bookings";
  return {
    id: `brief-${section.key}-${index}`,
    siteId: ctx.siteIds[0] ?? "",
    role: "all",
    priority: line.priority,
    title: line.title,
    detail: line.detail,
    metric,
  };
}

/**
 * Sort lines for the headline. Priority first, then larger money / counts, so
 * the most pressing, highest-value item leads.
 */
function lineWeight(line: BriefLine): number {
  return (line.value ?? 0) + (line.count ?? 0);
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export async function generateBrief(ctx: BriefContext): Promise<DailyBrief> {
  const state: BuildState = { appointmentsToday: 0 };

  // Build every section. Each builder is internally resilient (safe()), and we
  // also guard the builders themselves so one throwing never sinks the brief.
  const builders: Array<Promise<BriefSection>> = [
    buildDiarySection(ctx, state).catch(() => emptySection("diary", "Today's diary")),
    buildNoshowSection(ctx).catch(() => emptySection("noshow", "No-show risks today")),
    buildArrivingValueSection(ctx).catch(() =>
      emptySection("arriving", "High-value treatment arriving today"),
    ),
    buildChaseSection(ctx).catch(() => emptySection("chase", "Who to chase")),
    buildOvernightSection(ctx).catch(() => emptySection("overnight", "Overnight after-hours")),
    buildMoneySection(ctx).catch(() => emptySection("money", "Money")),
  ];
  const built = await Promise.all(builders);

  // Role-aware emphasis. Coordinators lead on recovery / confirmations /
  // after-hours / payments; owners and agency admins see everything including
  // the money sections up top.
  const ordered = orderSectionsForRole(built, ctx.role);

  // Headline: flatten all section lines, rank by priority then weight, take the
  // top 4-6, and map into the dashboard's BriefItem shape.
  const flat: Array<{ line: BriefLine; section: BriefSection; index: number }> = [];
  for (const section of ordered) {
    section.items.forEach((line, index) => flat.push({ line, section, index }));
  }
  flat.sort((a, b) => {
    const byPriority = PRIORITY_RANK[a.line.priority] - PRIORITY_RANK[b.line.priority];
    if (byPriority !== 0) return byPriority;
    return lineWeight(b.line) - lineWeight(a.line);
  });
  const headline = flat
    .slice(0, 6)
    .map(({ line, section, index }) => lineToBriefItem(line, section, ctx, index));

  return {
    generatedAt: ctx.now.toISOString(),
    role: ctx.role,
    appointmentsToday: state.appointmentsToday,
    sections: ordered.filter((s) => s.items.length > 0),
    headline,
  };
}

function emptySection(key: string, title: string): BriefSection {
  return { key, title, items: [] };
}

/**
 * Reorder sections by role. Coordinators are operational: recovery, no-show
 * confirmations, after-hours and payments first. Owners / agency admins keep the
 * diary-led order with money surfaced.
 */
function orderSectionsForRole(sections: BriefSection[], role: BriefContext["role"]): BriefSection[] {
  const byKey = new Map(sections.map((s) => [s.key, s]));
  const order =
    role === "client_coordinator"
      ? ["arriving", "noshow", "overnight", "chase", "money", "diary"]
      : ["diary", "arriving", "noshow", "chase", "overnight", "money"];
  const out: BriefSection[] = [];
  for (const key of order) {
    const s = byKey.get(key);
    if (s) out.push(s);
  }
  // Append any section not named in the order (defensive against future keys).
  for (const s of sections) if (!order.includes(s.key)) out.push(s);
  return out;
}
