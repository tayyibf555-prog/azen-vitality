import type { Appointment, BriefItem, Lead, RecallItem, TreatmentPlan } from "@/lib/types";

/**
 * Operational mock fixtures, all site-scoped. Modest but realistic so the shell
 * and Overview look alive. Module sessions will replace these with live selectors.
 */

export const LEADS: Lead[] = [
  { id: "l-1", siteId: "site-cc", name: "Hannah Doyle", stage: "new", assessmentScore: 88, treatmentInterest: "Invisalign", source: "Meta Ads", createdAt: "2026-06-18T08:46:00Z", firstResponseSeconds: 22, channel: "whatsapp" },
  { id: "l-2", siteId: "site-cc", name: "Marcus Webb", stage: "qualifying", assessmentScore: 74, treatmentInterest: "Implants", source: "Google", createdAt: "2026-06-18T08:10:00Z", firstResponseSeconds: 28, channel: "sms" },
  { id: "l-3", siteId: "site-rv", name: "Priya Nair", stage: "booked", assessmentScore: 91, treatmentInterest: "Invisalign", source: "Referral", createdAt: "2026-06-17T16:30:00Z", firstResponseSeconds: 19, channel: "whatsapp" },
  { id: "l-4", siteId: "site-rv", name: "Tom Fletcher", stage: "contacted", assessmentScore: 52, treatmentInterest: "Hygiene", source: "Meta Ads", createdAt: "2026-06-17T14:05:00Z", firstResponseSeconds: 41, channel: "email" },
  { id: "l-5", siteId: "site-ng", name: "Sofia Marin", stage: "new", assessmentScore: 67, treatmentInterest: "Whitening", source: "Instagram", createdAt: "2026-06-18T07:58:00Z", firstResponseSeconds: null, channel: "sms" },
  { id: "l-6", siteId: "site-cc", name: "Daniel Okafor", stage: "lost", assessmentScore: 33, treatmentInterest: "Hygiene", source: "Google", createdAt: "2026-06-15T11:20:00Z", firstResponseSeconds: 380, channel: "email" },
];

export const APPOINTMENTS: Appointment[] = [
  { id: "a-1", siteId: "site-cc", patientName: "Priya Nair", practitioner: "Dr Hale", treatment: "Invisalign consult", state: "confirmed", start: "2026-06-18T10:30:00Z", value: 0, bookedViaApi: true },
  { id: "a-2", siteId: "site-cc", patientName: "George Mills", practitioner: "Dr Hale", treatment: "Implant review", state: "arrived", start: "2026-06-18T09:15:00Z", value: 2400, bookedViaApi: true },
  { id: "a-3", siteId: "site-rv", patientName: "Lucy Chen", practitioner: "Dr Osei", treatment: "Hygiene", state: "completed", start: "2026-06-18T08:00:00Z", value: 85, bookedViaApi: false },
  { id: "a-4", siteId: "site-rv", patientName: "Ben Carter", practitioner: "Dr Osei", treatment: "Invisalign fit", state: "pending", start: "2026-06-18T13:00:00Z", value: 3200, bookedViaApi: true },
  { id: "a-5", siteId: "site-ng", patientName: "Amelia Ford", practitioner: "Dr Singh", treatment: "Whitening", state: "did_not_attend", start: "2026-06-17T15:30:00Z", value: 350, bookedViaApi: false },
];

export const RECALL_ITEMS: RecallItem[] = [
  { id: "r-1", siteId: "site-cc", patientName: "Olivia Grant", type: "hygienist", dueDate: "2026-06-19T00:00:00Z", consent: { sms: true, email: true }, status: "due", lastContactedAt: null },
  { id: "r-2", siteId: "site-cc", patientName: "Raj Patel", type: "dentist", dueDate: "2026-06-20T00:00:00Z", consent: { sms: true, email: false }, status: "contacted", lastContactedAt: "2026-06-18T07:30:00Z" },
  { id: "r-3", siteId: "site-rv", patientName: "Emma Wallace", type: "hygienist", dueDate: "2026-06-18T00:00:00Z", consent: { sms: false, email: true }, status: "booked", lastContactedAt: "2026-06-16T09:00:00Z" },
  { id: "r-4", siteId: "site-ng", patientName: "Noah Bright", type: "dentist", dueDate: "2026-06-21T00:00:00Z", consent: { sms: true, email: true }, status: "no_response", lastContactedAt: "2026-06-14T10:00:00Z" },
];

export const TREATMENT_PLANS: TreatmentPlan[] = [
  { id: "t-1", siteId: "site-cc", patientName: "Sarah Lindqvist", treatment: "Invisalign full arch", plannedValue: 3400, acceptedAt: "2026-05-28T00:00:00Z", status: "stalled", financePresented: false, lastTouchAt: "2026-06-09T00:00:00Z" },
  { id: "t-2", siteId: "site-cc", patientName: "David Reuben", treatment: "Implant + crown", plannedValue: 2800, acceptedAt: "2026-06-02T00:00:00Z", status: "accepted", financePresented: false, lastTouchAt: null },
  { id: "t-3", siteId: "site-rv", patientName: "Yusuf Khan", treatment: "Veneers x6", plannedValue: 4200, acceptedAt: "2026-05-20T00:00:00Z", status: "in_progress", financePresented: true, lastTouchAt: "2026-06-15T00:00:00Z" },
  { id: "t-4", siteId: "site-ng", patientName: "Grace Mooney", treatment: "Composite bonding", plannedValue: 1600, acceptedAt: "2026-05-12T00:00:00Z", status: "stalled", financePresented: true, lastTouchAt: "2026-06-01T00:00:00Z" },
];

export const BRIEF_ITEMS: BriefItem[] = [
  { id: "b-1", siteId: "site-cc", role: "client_coordinator", priority: "high", title: "Re-present finance to Sarah Lindqvist", detail: "Accepted £3,400 Invisalign, stalled 9 days, no finance presented yet.", metric: "revenue" },
  { id: "b-2", siteId: "site-cc", role: "client_coordinator", priority: "high", title: "Confirm George Mills (arrived)", detail: "High-value implant review in surgery shortly. Make sure notes are ready.", metric: "bookings" },
  { id: "b-3", siteId: "site-ng", role: "client_owner", priority: "medium", title: "Northgate no-show rate at 14%", detail: "Above the 10% threshold this week. Reminder cadence may need tightening.", metric: "risk" },
  { id: "b-4", siteId: "site-cc", role: "all", priority: "medium", title: "3 hygienist recalls due tomorrow", detail: "All consented for SMS. Recall concierge will handle unless paused.", metric: "bookings" },
  { id: "b-5", siteId: "site-rv", role: "client_coordinator", priority: "low", title: "Tom Fletcher waiting 41s for first contact", detail: "Just outside the 30s target. Worth a quick callback.", metric: "time" },
];
