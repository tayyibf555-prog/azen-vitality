// ROI (growth) domain types: a practice-wide view that ties patient-acquisition
// spend to leads, booked patients and treatment revenue, by channel. This is a
// PURE-DATA layer: no React, no network. Everything is mock/derived and shaped
// to be swapped later for the real sources (Meta Marketing API for ad spend and
// leads, Dentally for bookings and treatment revenue) without changing consumers.
//
// Money is always GBP (the £ symbol lives only in human-readable strings).
// Single practice: Vitality Dental, three sites (City Centre, Riverside, Northgate).

// One stage of the acquisition funnel, from first enquiry through to a new patient
// (or a reactivated existing one). count is the number of people at this stage over
// the period; conversionFromPrev is the fraction that carried over from the previous
// stage (0..1). The first stage has conversionFromPrev = 1 (nothing precedes it).
export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  conversionFromPrev: number; // 0..1; 1 for the first stage
}

// One acquisition channel and its 30-day economics. All money fields are GBP.
// Derived fields are kept on the object so consumers do not recompute them, but
// they are internally consistent: cplGbp = spendGbp / leads, cpaGbp = spendGbp /
// newPatients, roiX = revenueGbp / spendGbp. For zero-spend channels (referral,
// organic, and near-zero concierge work) cplGbp / cpaGbp are 0 and roiX is null,
// which the UI renders as "-" rather than dividing by zero.
export interface Channel {
  id: string; // e.g. "meta-ads", "smile-assessment", "speed-to-lead"
  name: string;
  spendGbp: number;
  leads: number;
  newPatients: number;
  revenueGbp: number;
  cplGbp: number; // cost per lead = spend / leads (0 when no spend)
  cpaGbp: number; // cost per acquisition = spend / newPatients (0 when no spend)
  roiX: number | null; // revenue / spend; null when spend is 0 (shown as "-")
}

// One month of the growth trend (oldest first). month is a short label ("Jan").
export interface TrendPoint {
  month: string;
  spendGbp: number;
  revenueGbp: number;
  newPatients: number;
}

// The whole practice-wide ROI summary for the period (last 30 days), plus a small
// 6-month trend. Totals roll up from the channels and the funnel rolls up to be
// consistent with them. returnX = revenueGbp / spendGbp across all channels;
// costPerAcquisitionGbp = spendGbp / newPatients across all channels.
export interface RoiSummary {
  periodDays: number;
  spendGbp: number;
  leads: number;
  newPatients: number;
  bookings: number;
  revenueGbp: number;
  costPerAcquisitionGbp: number; // spend / newPatients across all channels
  returnX: number; // revenue / spend across all channels
  funnel: FunnelStage[];
  channels: Channel[];
  trend: TrendPoint[];
}
