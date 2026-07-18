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
  /** True when there is enough live activity to write a useful review. */
  hasEnoughData: boolean;
}

const WINDOW_DAYS: Record<ReportPeriod, number> = { week: 7, month: 30 };

// Minimum real enquiries in the window before an AI review is worth writing. Below
// this, the report stays locked and the caller shows an honest awaiting message.
const MIN_ENQUIRIES: Record<ReportPeriod, number> = { week: 3, month: 8 };

/**
 * Build a snapshot of the practice's REAL position for the chosen period, scoped to
 * the given sites. Reads the live enquiry store; on any error it degrades to an
 * empty (zero-activity) snapshot rather than throwing, so the page never breaks.
 */
export async function buildSnapshot(
  period: ReportPeriod,
  siteIds: string[],
): Promise<ReportSnapshot> {
  const cutoff = Date.now() - WINDOW_DAYS[period] * 24 * 60 * 60 * 1000;

  let leads: SpeedToLeadLead[] = [];
  try {
    leads = await listLeads({ siteIds, limit: 500 });
  } catch {
    leads = [];
  }

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
    hasEnoughData: enquiries >= MIN_ENQUIRIES[period],
  };
}
