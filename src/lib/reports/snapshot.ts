// Period snapshot for the Reports section. A compact, deterministic roll-up of
// the practice's current numbers from three existing mock sources, scaled to a
// weekly or monthly window. PURE DATA: no React, no network. The figures are
// consistent with the ROI and Compliance sections by construction, because they
// are derived from the same ROI_SUMMARY, ACCOUNT_SUMMARY and READINESS modules.
//
// All money is GBP. The ROI figures are a 30-day (monthly) view; for the weekly
// window we scale them down by an average-weeks-per-month factor so a weekly
// review reads sensibly and differs from the monthly one. Compliance position is
// a point-in-time picture and is not scaled.

import { ROI_SUMMARY, scaleRoiSummary, topChannelByRoi } from "@/lib/roi/mock";
import type { Channel, RoiSummary } from "@/lib/roi/types";
import { READINESS } from "@/lib/compliance/mock";

export type ReportPeriod = "week" | "month";

/** Average weeks in a month, used to scale the 30-day ROI numbers to a week. */
const WEEKS_PER_MONTH = 4.3;

/** Round to a whole number (counts: leads, patients). */
function roundInt(value: number): number {
  return Math.round(value);
}

/** Round money to the nearest pound. */
function roundMoney(value: number): number {
  return Math.round(value);
}

/** Round a multiple to 1dp (e.g. return on spend). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface ReportSnapshot {
  period: ReportPeriod;
  /** Human label for the window, e.g. "last 7 days" / "last 30 days". */
  windowLabel: string;
  // Acquisition: spend -> leads -> new patients -> revenue and return on spend.
  spendGbp: number;
  leads: number;
  newPatients: number;
  revenueGbp: number;
  returnX: number;
  costPerNewPatientGbp: number;
  // Channels (by return on spend), so the report can name what is working.
  topChannel: { name: string; roiX: number } | null;
  weakestChannel: { name: string; roiX: number } | null;
  // Conversion headline: the enquiry -> new patient rate across the funnel.
  enquiryToPatientRate: number; // 0..1
  bookedToAttendedRate: number; // 0..1
  // Compliance position (point in time, not scaled).
  complianceScore: number;
  auditsOverdue: number;
  // Lifecycle/retention signal: the near-zero-cost recall + reactivation revenue.
  lifecycleRevenueGbp: number;
  // Month-only: the direction of travel from the trend (new patients).
  trendDirection: "improving" | "steady" | "declining" | null;
}

/** Scale a 30-day figure to the snapshot window (identity for month). */
function scaleToWindow(value: number, period: ReportPeriod): number {
  return period === "week" ? value / WEEKS_PER_MONTH : value;
}

// The channel with the LOWEST return on spend among those that actually spend
// (zero-spend channels carry a null ROI and are not a fair "weakest" pick).
function weakestSpendingChannel(summary: RoiSummary): Channel | null {
  const withRoi = summary.channels.filter(
    (c): c is Channel & { roiX: number } => c.roiX !== null,
  );
  if (withRoi.length === 0) return null;
  return withRoi.reduce((worst, c) => (c.roiX < worst.roiX ? c : worst));
}

// Direction of travel for new patients over the trend (compare the last point to
// the one before it). Only meaningful for the monthly review.
function trendDirection(summary: RoiSummary): ReportSnapshot["trendDirection"] {
  const t = summary.trend;
  if (t.length < 2) return "steady";
  const last = t[t.length - 1].newPatients;
  const prev = t[t.length - 2].newPatients;
  if (last > prev) return "improving";
  if (last < prev) return "declining";
  return "steady";
}

/**
 * Build a compact snapshot of the practice's position for the chosen period.
 * Deterministic and pure: same inputs in, same object out, ready to feed the
 * report prompt or render above the AI output.
 *
 * `share` scopes the ROI-derived figures to the selected site(s): the site's
 * fraction of client recovered revenue (0..1). It defaults to 1 (all sites), so
 * existing callers are unchanged. Compliance (READINESS) figures are point-in-time
 * and are NOT scaled.
 */
export function buildSnapshot(period: ReportPeriod, share = 1): ReportSnapshot {
  const s = scaleRoiSummary(ROI_SUMMARY, share);

  const spendGbp = roundMoney(scaleToWindow(s.spendGbp, period));
  const leads = roundInt(scaleToWindow(s.leads, period));
  const newPatients = roundInt(scaleToWindow(s.newPatients, period));
  const revenueGbp = roundMoney(scaleToWindow(s.revenueGbp, period));
  // Ratios (return on spend, cost per patient) are scale-invariant, so they are
  // computed from the unscaled totals to stay exact and match the ROI section.
  const returnX = round1(s.returnX);
  const costPerNewPatientGbp = roundMoney(s.costPerAcquisitionGbp);

  const top = topChannelByRoi(s);
  const weakest = weakestSpendingChannel(s);

  // Conversion headlines straight off the funnel (scale-invariant fractions).
  const first = s.funnel[0];
  const last = s.funnel[s.funnel.length - 1];
  const enquiryToPatientRate =
    first.count > 0 ? Math.round((last.count / first.count) * 100) / 100 : 0;
  const booked = s.funnel.find((f) => f.key === "booked");
  const attended = s.funnel.find((f) => f.key === "attended");
  const bookedToAttendedRate =
    booked && attended && booked.count > 0
      ? Math.round((attended.count / booked.count) * 100) / 100
      : 0;

  // Lifecycle revenue: recall + reactivation, the near-zero-cost retention engine.
  const lifecycleRevenueGbp = roundMoney(
    scaleToWindow(
      s.channels
        .filter((c) => c.id === "recall" || c.id === "reactivation")
        .reduce((total, c) => total + c.revenueGbp, 0),
      period,
    ),
  );

  return {
    period,
    windowLabel: period === "week" ? "last 7 days" : "last 30 days",
    spendGbp,
    leads,
    newPatients,
    revenueGbp,
    returnX,
    costPerNewPatientGbp,
    topChannel: top && top.roiX !== null ? { name: top.name, roiX: round1(top.roiX) } : null,
    weakestChannel:
      weakest && weakest.roiX !== null ? { name: weakest.name, roiX: round1(weakest.roiX) } : null,
    enquiryToPatientRate,
    bookedToAttendedRate,
    complianceScore: READINESS.overallScore,
    auditsOverdue: READINESS.auditsOverdue,
    lifecycleRevenueGbp,
    trendDirection: period === "month" ? trendDirection(s) : null,
  };
}
