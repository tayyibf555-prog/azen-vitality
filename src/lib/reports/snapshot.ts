// Period snapshot for the Reports section. A compact roll-up of the practice's
// REAL activity for a weekly or monthly window, read from the live enquiry store
// (Speed-to-lead). No fabricated figures: where a metric has no live source yet
// (ad spend, attributed revenue, return on spend, compliance position) it is simply
// absent from the snapshot, the prompt and the page. When there is too little live
// activity to write a useful review, `hasEnoughData` is false and the caller shows
// an honest awaiting state instead of an AI narrative.
//
// THE COUNTS AND THE DETAIL COME FROM DIFFERENT READS, ON PURPOSE.
//
//   how many          COUNTED in Postgres (`count: "exact"`, no rows returned), so
//                     "412 enquiries" is a total at any volume and never a floor.
//   what they were    READ, bounded, from the newest SNAPSHOT_LEAD_LIMIT leads in
//                     the window — the only way to average a response time or find
//                     the commonest source is to hold the rows.
//
// This split is the point. The enquiry store is OUR OWN database, not Dentally: a
// count there is exact and costs the same whether the month held five leads or fifty
// thousand, so the honest-but-blank "this period is bigger than one read" answer the
// snapshot used to give for its headline figures was never necessary for them. It
// IS still necessary for the derived figures, and `truncated` now says exactly that
// and only that.

import { countLeadsInWindow, listLeads } from "@/lib/speed-to-lead/repository";
import { firstResponseSeconds } from "@/lib/speed-to-lead/types";
import type { SpeedToLeadLead } from "@/lib/speed-to-lead/types";

export type ReportPeriod = "week" | "month";

export interface ReportSnapshot {
  period: ReportPeriod;
  /** Human label for the window, e.g. "last 7 days" / "last 30 days". */
  windowLabel: string;
  // Real acquisition activity from live enquiries.
  enquiries: number; // leads created in the window (counted, when `countsExact`)
  /**
   * Leads that received a first response. FROM THE DETAIL SAMPLE, always: it is the
   * denominator of `avgFirstResponseSeconds` and the two must describe the same set
   * of leads. An exact contacted count over a sampled mean would read as one figure
   * ("we answered 900 enquiries in 42 seconds") and be two.
   */
  contacted: number;
  booked: number; // leads that reached the 'booked' stage (counted, when `countsExact`)
  enquiryToBookedRate: number; // 0..1
  avgFirstResponseSeconds: number | null; // null when nothing was contacted; from the sample
  topSource: { source: string; count: number } | null; // from the sample
  /**
   * True when there is enough live activity to write a useful review AND the figures
   * behind it are known. False covers three different states — too little activity,
   * a read that failed, and (only when the counts could not be counted) a window
   * bigger than one read — which `readFailed`, `truncated` and `countsExact` tell
   * apart.
   */
  hasEnoughData: boolean;
  /** The live enquiry store could not be read. The figures above are NOT zero activity. */
  readFailed: boolean;
  /**
   * The window holds more enquiries than the DETAIL read carries, so the sampled
   * figures (contacted, average first response, top source) describe the newest
   * SNAPSHOT_LEAD_LIMIT enquiries in it rather than all of them.
   *
   * On its own this no longer makes the headline counts a floor: with `countsExact`
   * they were counted, not sampled. It only does so when the count failed too, which
   * is the one case that still has to be shown as unusable.
   */
  truncated: boolean;
  /**
   * `enquiries` and `booked` are exact totals from the store rather than the length
   * of a bounded sample. False means the count query failed and the sample's own
   * lengths were used, which are a floor whenever `truncated`.
   */
  countsExact: boolean;
}

const WINDOW_DAYS: Record<ReportPeriod, number> = { week: 7, month: 30 };

/**
 * The most enquiries one snapshot READS IN DETAIL.
 *
 * The read is bounded, so the bound has to be VISIBLE. This used to fetch the newest
 * 500 leads across all history and then filter to the window in memory — the same
 * shape of mistake the Dentally reads carried (see flagship-read.ts): a bounded read
 * whose result was presented as a complete count. listLeads' own doc-comment warns
 * about it in as many words, which is why `sinceIso` exists.
 *
 * What the bound now limits is the DETAIL, not the count. A window busier than this
 * still says so — `truncated` — but it says it about the average response time and
 * the source mix, the two figures that genuinely need the rows, instead of blanking
 * an enquiry total that Postgres will count exactly for the price of one query.
 */
export const SNAPSHOT_LEAD_LIMIT = 500;

// Minimum real enquiries in the window before an AI review is worth writing. Below
// this, the report stays locked and the caller shows an honest awaiting message.
const MIN_ENQUIRIES: Record<ReportPeriod, number> = { week: 3, month: 8 };

/** The bounded detail read. Never throws: a failure is a FACT the snapshot carries. */
async function readDetail(
  period: ReportPeriod,
  siteIds: string[],
  sinceIso: string,
): Promise<{ leads: SpeedToLeadLead[]; failed: boolean }> {
  try {
    const leads = await listLeads({ siteIds, limit: SNAPSHOT_LEAD_LIMIT, sinceIso });
    return { leads, failed: false };
  } catch (err) {
    console.error(`[reports] snapshot enquiry read failed for ${period}`, err);
    return { leads: [], failed: true };
  }
}

/**
 * The exact enquiry and booking totals for the window, or null when the count query
 * failed. Null is not zero: the caller falls back to the sample's lengths and marks
 * the counts inexact, which is exactly the behaviour that existed before counting.
 *
 * Two counts, not one over-fetch: `head: true` returns no rows, so this is two
 * index counts rather than two reads.
 */
async function readExactCounts(
  period: ReportPeriod,
  siteIds: string[],
  sinceIso: string,
): Promise<{ enquiries: number; booked: number } | null> {
  try {
    const [enquiries, booked] = await Promise.all([
      countLeadsInWindow(siteIds, sinceIso),
      countLeadsInWindow(siteIds, sinceIso, ["booked"]),
    ]);
    return { enquiries, booked };
  } catch (err) {
    console.error(`[reports] snapshot enquiry count failed for ${period}`, err);
    return null;
  }
}

/**
 * Build a snapshot of the practice's REAL position for the chosen period, scoped to
 * the given sites.
 *
 * THE WINDOW IS ASKED FOR, NOT FILTERED FOR. `sinceIso` puts the period in both
 * QUERIES, so the detail bound is spent on the window rather than on however much
 * history happens to sit in front of it, and a saturated detail read means "this
 * window holds more enquiries than the sample carries" rather than "this window
 * might be missing its older half".
 *
 * A FAILED READ IS NOT A QUIET WEEK. The read still never throws — the page must
 * not break — but it no longer degrades into a zero-activity snapshot that looks
 * exactly like a practice nobody rang. `readFailed` carries that apart, and gates
 * the AI review the same way too-little-activity does.
 *
 * A FAILED DETAIL READ DOMINATES a successful count. Without the rows there is no
 * response time, no source and no contacted figure, and a snapshot showing "412
 * enquiries, nobody contacted, no source" is a worse lie than showing nothing.
 */
export async function buildSnapshot(
  period: ReportPeriod,
  siteIds: string[],
): Promise<ReportSnapshot> {
  const cutoff = Date.now() - WINDOW_DAYS[period] * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(cutoff).toISOString();

  const [detail, counted] = await Promise.all([
    readDetail(period, siteIds, sinceIso),
    readExactCounts(period, siteIds, sinceIso),
  ]);
  const readFailed = detail.failed;

  // Saturating the bound means there is at least this much in the window and
  // possibly more. The client-side window filter below is kept as a belt on the
  // query's braces (the store's clock is not this process's clock), so measure
  // truncation on what came back, before that filter can hide it.
  const truncated = detail.leads.length >= SNAPSHOT_LEAD_LIMIT;

  const inWindow = detail.leads.filter((l) => {
    const t = new Date(l.createdAt).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  });

  const exact = readFailed ? null : counted;
  const countsExact = exact !== null;
  const enquiries = exact ? exact.enquiries : inWindow.length;
  const booked = exact ? exact.booked : inWindow.filter((l) => l.stage === "booked").length;

  const responseTimes = inWindow
    .map((l) => firstResponseSeconds(l))
    .filter((s): s is number => s !== null);
  const contacted = responseTimes.length;
  const avgFirstResponseSeconds = contacted
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / contacted)
    : null;

  // Most common enquiry source over the window (real).
  const bySource = new Map<string, number>();
  for (const l of inWindow) bySource.set(l.source, (bySource.get(l.source) ?? 0) + 1);
  let topSource: { source: string; count: number } | null = null;
  for (const [source, count] of bySource) {
    if (!topSource || count > topSource.count) topSource = { source, count };
  }

  const enquiryToBookedRate = enquiries > 0 ? Math.round((booked / enquiries) * 100) / 100 : 0;

  return {
    period,
    windowLabel: period === "week" ? "last 7 days" : "last 30 days",
    enquiries,
    contacted,
    booked,
    enquiryToBookedRate,
    avgFirstResponseSeconds,
    topSource,
    // A review is written only over figures the snapshot can stand behind. A read
    // that failed would be narrated as a quiet month; counts that are a floor would
    // be narrated as totals — which is the exact failure this whole pass exists to
    // remove. A COUNTED window is not a floor, however busy it was, so a truncated
    // detail read no longer locks the review: it changes how the prompt words the
    // two figures that came from the sample (see ai.ts).
    hasEnoughData:
      !readFailed && (countsExact || !truncated) && enquiries >= MIN_ENQUIRIES[period],
    readFailed,
    truncated,
    countsExact,
  };
}

/**
 * Can this period's figures be put in front of the owner?
 *
 * Two different questions live in this file and they were previously one: "is this
 * snapshot showable" and "is there enough here to write a review" (`hasEnoughData`).
 * A perfectly readable quiet week is showable and not reviewable, and the page needs
 * to tell those apart to avoid answering "how did last week go" with a blank.
 */
export function snapshotUsable(s: ReportSnapshot): boolean {
  return !s.readFailed && (s.countsExact || !s.truncated);
}

/** What the Reports page should render for a pair of period snapshots. */
export type ReportsGate =
  | { kind: "workspace"; defaultPeriod: ReportPeriod }
  | { kind: "awaiting" }
  | { kind: "unavailable"; readFailed: boolean };

/**
 * THE WHOLE PAGE MUST NOT HANG ON ONE PERIOD.
 *
 * The reports workspace used to be gated on the MONTH snapshot alone: one unusable
 * month blanked the Week tab, the week's perfectly countable figures, and the
 * Generate button with it. The failure mode that mattered was a busy month — the
 * page went dark precisely when the practice was busiest, which is when the owner
 * has most reason to open it.
 *
 * So the workspace renders when EITHER period is usable, and the tab the owner lands
 * on is a usable one. The unusable tab is not hidden or faked: its own strip states
 * why, per period, in its own words.
 */
export function reportsGate(snapshots: Record<ReportPeriod, ReportSnapshot>): ReportsGate {
  // Month first: it is the headline window, and the one the page's stat cards read.
  const order: ReportPeriod[] = ["month", "week"];
  const usable = order.filter((p) => snapshotUsable(snapshots[p]));
  if (usable.length === 0) {
    // Both are unusable, so the month is too, and the month's own reason is the
    // honest one to show for a page whose headline figures are the 30-day ones.
    return { kind: "unavailable", readFailed: snapshots.month.readFailed };
  }
  const withActivity = usable.filter((p) => snapshots[p].enquiries > 0);
  if (withActivity.length === 0) return { kind: "awaiting" };
  return { kind: "workspace", defaultPeriod: withActivity[0] };
}
