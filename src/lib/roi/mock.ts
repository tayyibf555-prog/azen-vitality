// ROI (growth) mock data: a practice-wide view of how patient-acquisition spend
// turns into leads, booked patients and treatment revenue across every channel.
// PURE DATA. This stands in for the real sources (Meta Marketing API for ad spend
// and leads; Dentally for bookings and treatment revenue) until they are connected.
//
// All money is GBP. Numbers are internally consistent for a 3-site UK dental
// practice over the last 30 days:
//
//   CHANNELS (sums used by the summary and the test):
//     spendGbp:     1907 + 120 + 0 + 0 + 0 + 0 + 0 = 2027
//     leads:        56 + 19 + 34 + 26 + 22 + 11 + 18 = 186
//     newPatients:  22 + 5 + 9 + 7 + 6 + 4 + 6 = 59
//     revenueGbp:   8200 + 1750 + 4300 + 6900 + 5400 + 3100 + 4250 = 33900
//
//   Per channel: cplGbp = spendGbp / leads, cpaGbp = spendGbp / newPatients,
//   roiX = revenueGbp / spendGbp. Zero-spend channels carry cplGbp = cpaGbp = 0
//   and roiX = null (never a divide-by-zero), rendered as "-" in the UI.
//
//   SUMMARY (rolls up the channels):
//     spendGbp = 2027, leads = 186, newPatients = 59, revenueGbp = 33900
//     bookings = 78 (consultations attended, the funnel's "Attended" stage)
//     costPerAcquisitionGbp = 2027 / 59 = 34.36
//     returnX = 33900 / 2027 = 16.7  (rounded for display)
//   The Meta Ads channel intentionally reuses ACCOUNT_SUMMARY's spend (1907) and
//   leads (56) so the ad-spend figure stays identical to the Meta Ads section.
//
//   FUNNEL (rolls down from the totals; each count <= the previous):
//     Enquiries 186  -> Consultations booked 102 (0.548 of enquiries)
//     -> Attended 78 (0.765) -> Treatment accepted 64 (0.821)
//     -> New patients 59 (0.922). The final stage equals the channel newPatients sum.
//
//   TREND: 6 months of steady growth in spend, revenue and new patients, ending on
//   the current period's figures (Jun = 2027 / 33900 / 59).

import type { Channel, FunnelStage, RoiSummary, TrendPoint } from "./types";
import { ACCOUNT_SUMMARY } from "@/lib/meta-ads/mock";

// Round to 2dp for stored derived money fields so display and assertions agree.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Build a channel row with derived cpl / cpa / roi. Zero spend yields 0 costs and
// a null ROI (shown as "-"); this is the single place divide-by-zero is guarded.
function channel(input: {
  id: string;
  name: string;
  spendGbp: number;
  leads: number;
  newPatients: number;
  revenueGbp: number;
}): Channel {
  const { spendGbp, leads, newPatients } = input;
  return {
    ...input,
    cplGbp: spendGbp > 0 && leads > 0 ? round2(spendGbp / leads) : 0,
    cpaGbp: spendGbp > 0 && newPatients > 0 ? round2(spendGbp / newPatients) : 0,
    roiX: spendGbp > 0 ? round2(input.revenueGbp / spendGbp) : null,
  };
}

// Seven channels spanning paid acquisition, AI-driven conversion of inbound, and
// near-zero-cost lifecycle and word-of-mouth growth. Meta Ads reuses the live-ish
// account summary so the spend matches the Meta Ads section exactly.
export const CHANNELS: Channel[] = [
  channel({
    id: "meta-ads",
    name: "Meta Ads",
    spendGbp: ACCOUNT_SUMMARY.spendGbp, // 1907
    leads: ACCOUNT_SUMMARY.leads, // 56
    newPatients: 22,
    revenueGbp: 8200,
  }),
  channel({
    id: "smile-assessment",
    name: "Smile assessment",
    spendGbp: 120, // small boost to drive quiz traffic
    leads: 19,
    newPatients: 5,
    revenueGbp: 1750,
  }),
  channel({
    id: "speed-to-lead",
    name: "Speed-to-lead",
    spendGbp: 0, // a process on top of inbound, no direct media cost
    leads: 34,
    newPatients: 9,
    revenueGbp: 4300,
  }),
  channel({
    id: "recall",
    name: "Recall concierge",
    spendGbp: 0, // near-zero: existing patients, messaging only
    leads: 26,
    newPatients: 7,
    revenueGbp: 6900,
  }),
  channel({
    id: "reactivation",
    name: "Reactivation",
    spendGbp: 0, // near-zero: lapsed patients from the existing database
    leads: 22,
    newPatients: 6,
    revenueGbp: 5400,
  }),
  channel({
    id: "referral",
    name: "Referral",
    spendGbp: 0,
    leads: 11,
    newPatients: 4,
    revenueGbp: 3100,
  }),
  channel({
    id: "organic",
    name: "Organic and walk-in",
    spendGbp: 0,
    leads: 18,
    newPatients: 6,
    revenueGbp: 4250,
  }),
];

// Sum a numeric field across all channels (used to keep the summary consistent).
function sum(pick: (c: Channel) => number): number {
  return CHANNELS.reduce((total, c) => total + pick(c), 0);
}

const TOTAL_SPEND = sum((c) => c.spendGbp); // 2027
const TOTAL_LEADS = sum((c) => c.leads); // 186
const TOTAL_NEW_PATIENTS = sum((c) => c.newPatients); // 59
const TOTAL_REVENUE = sum((c) => c.revenueGbp); // 33900

// Consultations attended over the period (the funnel's "Attended" stage). Booked
// patients that turned up; a subset go on to accept treatment and become patients.
const ATTENDED = 78;

// The acquisition funnel, from enquiry to new patient. Counts roll down from the
// totals and the final stage equals the channel newPatients sum. conversionFromPrev
// is the fraction carried over from the stage above (the first stage is 1).
export const FUNNEL: FunnelStage[] = [
  { key: "enquiries", label: "Enquiries", count: TOTAL_LEADS, conversionFromPrev: 1 },
  { key: "booked", label: "Consultations booked", count: 102, conversionFromPrev: round2(102 / TOTAL_LEADS) },
  { key: "attended", label: "Attended", count: ATTENDED, conversionFromPrev: round2(ATTENDED / 102) },
  { key: "accepted", label: "Treatment accepted", count: 64, conversionFromPrev: round2(64 / ATTENDED) },
  {
    key: "new-patients",
    label: "New patients",
    count: TOTAL_NEW_PATIENTS,
    conversionFromPrev: round2(TOTAL_NEW_PATIENTS / 64),
  },
];

// Six months of growth, oldest first, ending on the current period's figures.
// Spend, revenue and new patients all trend upward as the channels ramp.
export const TREND: TrendPoint[] = [
  { month: "Jan", spendGbp: 1280, revenueGbp: 19400, newPatients: 38 },
  { month: "Feb", spendGbp: 1410, revenueGbp: 21800, newPatients: 41 },
  { month: "Mar", spendGbp: 1560, revenueGbp: 24600, newPatients: 45 },
  { month: "Apr", spendGbp: 1720, revenueGbp: 27900, newPatients: 50 },
  { month: "May", spendGbp: 1880, revenueGbp: 30800, newPatients: 54 },
  { month: "Jun", spendGbp: TOTAL_SPEND, revenueGbp: TOTAL_REVENUE, newPatients: TOTAL_NEW_PATIENTS },
];

// The practice-wide ROI summary. Totals roll up from the channels; the funnel and
// trend are consistent with them. returnX and costPerAcquisitionGbp are derived
// from the totals and guarded against zero (the practice always has some spend).
export const ROI_SUMMARY: RoiSummary = {
  periodDays: 30,
  spendGbp: TOTAL_SPEND,
  leads: TOTAL_LEADS,
  newPatients: TOTAL_NEW_PATIENTS,
  bookings: ATTENDED,
  revenueGbp: TOTAL_REVENUE,
  costPerAcquisitionGbp: TOTAL_NEW_PATIENTS > 0 ? round2(TOTAL_SPEND / TOTAL_NEW_PATIENTS) : 0,
  returnX: TOTAL_SPEND > 0 ? round2(TOTAL_REVENUE / TOTAL_SPEND) : 0,
  funnel: FUNNEL,
  channels: CHANNELS,
  trend: TREND,
};

// --- Pure helper selectors (minimal) -------------------------------------------

// The channel with the highest return on spend. Zero-spend channels (roiX = null)
// are excluded because their return is undefined rather than infinite.
export function topChannelByRoi(summary: RoiSummary = ROI_SUMMARY): Channel | null {
  const withRoi = summary.channels.filter((c): c is Channel & { roiX: number } => c.roiX !== null);
  if (withRoi.length === 0) return null;
  return withRoi.reduce((best, c) => (c.roiX > best.roiX ? c : best));
}

// The channel that brought in the most attributed revenue (the growth engine).
export function topChannelByRevenue(summary: RoiSummary = ROI_SUMMARY): Channel | null {
  if (summary.channels.length === 0) return null;
  return summary.channels.reduce((best, c) => (c.revenueGbp > best.revenueGbp ? c : best));
}
