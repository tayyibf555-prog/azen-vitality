// Period snapshot for the Reports section. A compact roll-up of the practice's
// REAL activity for a weekly or monthly window, read from the live enquiry store
// (Speed-to-lead). No fabricated figures: where a metric has no live source yet
// (ad spend, attributed revenue, return on spend, compliance position) it is simply
// absent from the snapshot, the prompt and the page. When there is too little live
// activity to write a useful review, `hasEnoughData` is false and the caller shows
// an honest awaiting state instead of an AI narrative.

import { listLeads } from "@/lib/speed-to-lead/repository";
import { firstResponseSeconds } from "@/lib/speed-to-lead/types";
import type { SpeedToLeadLead } from "@/lib/speed-to-lead/types";

export type ReportPeriod = "week" | "month";

export interface ReportSnapshot {
  period: ReportPeriod;
  /** Human label for the window, e.g. "last 7 days" / "last 30 days". */
  windowLabel: string;
  // Real acquisition activity from live enquiries.
  enquiries: number; // leads created in the window
  contacted: number; // leads that received a first response
  booked: number; // leads that reached the 'booked' stage
  enquiryToBookedRate: number; // 0..1
  avgFirstResponseSeconds: number | null; // null when nothing was contacted
  topSource: { source: string; count: number } | null;
  /**
   * True when there is enough live activity to write a useful review AND the
   * figures above are known to be complete. False covers three different states —
   * too little activity, a read that failed, and a window bigger than one read —
   * which `readFailed` and `truncated` tell apart.
   */
  hasEnoughData: boolean;
  /** The live enquiry store could not be read. The figures above are NOT zero activity. */
  readFailed: boolean;
  /** The window holds more enquiries than one read carries, so the counts are a floor. */
  truncated: boolean;
}

const WINDOW_DAYS: Record<ReportPeriod, number> = { week: 7, month: 30 };

/**
 * The most enquiries one snapshot reads.
 *
 * The read is bounded, so the bound has to be VISIBLE. This used to fetch the newest
 * 500 leads across all history and then filter to the window in memory — the same
 * shape of mistake the Dentally reads carried (see flagship-read.ts): a bounded read
 * whose result was presented as a complete count. listLeads' own doc-comment warns
 * about it in as many words, which is why `sinceIso` exists. A window busier than
 * this now says so instead of publishing a floor as a total, because these figures
 * are read aloud by the AI review as fact.
 */
const SNAPSHOT_LEAD_LIMIT = 500;

// Minimum real enquiries in the window before an AI review is worth writing. Below
// this, the report stays locked and the caller shows an honest awaiting message.
const MIN_ENQUIRIES: Record<ReportPeriod, number> = { week: 3, month: 8 };

/**
 * Build a snapshot of the practice's REAL position for the chosen period, scoped to
 * the given sites.
 *
 * THE WINDOW IS ASKED FOR, NOT FILTERED FOR. `sinceIso` puts the period in the
 * QUERY, so the bound is spent on the window rather than on however much history
 * happens to sit in front of it, and a saturated read means "this window is bigger
 * than one read" rather than "this window might be missing its older half".
 *
 * A FAILED READ IS NOT A QUIET WEEK. The read still never throws — the page must
 * not break — but it no longer degrades into a zero-activity snapshot that looks
 * exactly like a practice nobody rang. `readFailed` carries that apart, and gates
 * the AI review the same way too-little-activity does.
 */
export async function buildSnapshot(
  period: ReportPeriod,
  siteIds: string[],
): Promise<ReportSnapshot> {
  const cutoff = Date.now() - WINDOW_DAYS[period] * 24 * 60 * 60 * 1000;

  let leads: SpeedToLeadLead[] = [];
  let readFailed = false;
  try {
    leads = await listLeads({
      siteIds,
      limit: SNAPSHOT_LEAD_LIMIT,
      sinceIso: new Date(cutoff).toISOString(),
    });
  } catch (err) {
    console.error(`[reports] snapshot enquiry read failed for ${period}`, err);
    readFailed = true;
    leads = [];
  }
  // Saturating the bound means there is at least this much in the window and
  // possibly more. The client-side window filter below is kept as a belt on the
  // query's braces (the store's clock is not this process's clock), so measure
  // truncation on what came back, before that filter can hide it.
  const truncated = leads.length >= SNAPSHOT_LEAD_LIMIT;

  const inWindow = leads.filter((l) => {
    const t = new Date(l.createdAt).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  });

  const enquiries = inWindow.length;
  const booked = inWindow.filter((l) => l.stage === "booked").length;

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
    // A review is written only over figures that are BOTH sufficient and known to be
    // whole. A truncated window would otherwise be narrated as fact by the model,
    // which is the exact failure this whole pass exists to remove; a failed read
    // would be narrated as a quiet month.
    hasEnoughData: !readFailed && !truncated && enquiries >= MIN_ENQUIRIES[period],
    readFailed,
    truncated,
  };
}
