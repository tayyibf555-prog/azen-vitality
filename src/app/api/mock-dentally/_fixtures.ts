// ===========================================================================
// Mock Dentally fixtures.
//
// This is a LOCAL MOCK that mirrors the real Dentally response shapes
// (developer.dentally.co) so the whole sync pipeline can run without a live
// sandbox. It is NOT real Dentally data.
//
// SHAPE NOTES (for re-mapping against the real sandbox later):
//   - Patient: top-level id / first_name / last_name / email_address /
//     mobile_phone, plus consent fields use_sms / use_email (boolean) and
//     marketing (integer 0/1), and active (boolean). These mirror the real
//     patient object exactly.
//   - TreatmentPlan: Dentally does NOT expose a clean
//     "treatment-plans-with-outstanding" list — in reality outstanding lives on
//     invoices/accounts. For this mock we carry `planned_private_treatment_value`
//     and `amount_outstanding` DIRECTLY on the plan to keep the sync runnable.
//     This is a MOCK SIMPLIFICATION to be remapped against the real sandbox.
//
// Reference "now" for these fixtures is 2026-06-18 (see src/lib/mock/clients.ts
// NOW). Status spread, relative to that date:
//   - STALLED (high value, no payment, accepted 40-120 days ago):  3
//   - IN_PROGRESS (partial paid, accepted recently):               2
//   - ACCEPTED (outstanding == planned, accepted < 30 days ago):   2
//   - COMPLETED (amount_outstanding == 0):                         2
//   Total: 9 plans across site-cc / site-rv / site-ng.
//
// Consent spread (so the consent gate is demonstrable):
//   - Most patients consent to SMS and/or email.
//   - pat-008 (Bartosz Kowalski) has use_sms:false, use_email:false,
//     marketing:0 — NO consent on any channel.
// ===========================================================================

export interface MockPatient {
  id: string;
  first_name: string;
  last_name: string;
  email_address: string;
  mobile_phone: string;
  use_sms: boolean;
  use_email: boolean;
  marketing: number; // 0 | 1 (integer, mirrors Dentally)
  active: boolean;
  site_id: string;
  archived?: boolean;
  archived_reason?: string | null;
  dentist_recall_date?: string | null;
  hygienist_recall_date?: string | null;
}

export interface MockTreatmentPlan {
  id: string;
  patient_id: string;
  site_id: string;
  name: string;
  planned_private_treatment_value: number;
  amount_outstanding: number;
  accepted_at: string; // ISO
  updated_at: string; // ISO
}

export interface MockPaymentPlan {
  id: string;
  patient_id: string;
  outstanding: number;
}

// --- Patients -------------------------------------------------------------
// Realistic UK names. Consent varies deliberately across the set.
export const MOCK_PATIENTS: MockPatient[] = [
  {
    id: "pat-001",
    first_name: "Eleanor",
    last_name: "Whitfield",
    email_address: "eleanor.whitfield@example.co.uk",
    mobile_phone: "+447700900001",
    use_sms: true,
    use_email: true,
    marketing: 1,
    active: true,
    site_id: "site-cc",
  },
  {
    id: "pat-002",
    first_name: "Rajesh",
    last_name: "Patel",
    email_address: "rajesh.patel@example.co.uk",
    mobile_phone: "+447700900002",
    use_sms: true,
    use_email: false,
    marketing: 1,
    active: true,
    site_id: "site-rv",
  },
  {
    id: "pat-003",
    first_name: "Sophie",
    last_name: "Armstrong",
    email_address: "sophie.armstrong@example.co.uk",
    mobile_phone: "+447700900003",
    use_sms: false,
    use_email: true,
    marketing: 1,
    active: true,
    site_id: "site-ng",
  },
  {
    id: "pat-004",
    first_name: "Callum",
    last_name: "Fraser",
    email_address: "callum.fraser@example.co.uk",
    mobile_phone: "+447700900004",
    use_sms: true,
    use_email: true,
    marketing: 0,
    active: true,
    site_id: "site-cc",
  },
  {
    id: "pat-005",
    first_name: "Aisha",
    last_name: "Begum",
    email_address: "aisha.begum@example.co.uk",
    mobile_phone: "+447700900005",
    use_sms: true,
    use_email: false,
    marketing: 1,
    active: true,
    site_id: "site-rv",
  },
  {
    id: "pat-006",
    first_name: "Thomas",
    last_name: "Hargreaves",
    email_address: "thomas.hargreaves@example.co.uk",
    mobile_phone: "+447700900006",
    use_sms: false,
    use_email: true,
    marketing: 1,
    active: true,
    site_id: "site-ng",
  },
  {
    id: "pat-007",
    first_name: "Megan",
    last_name: "Lloyd",
    email_address: "megan.lloyd@example.co.uk",
    mobile_phone: "+447700900007",
    use_sms: true,
    use_email: true,
    marketing: 1,
    active: true,
    site_id: "site-cc",
  },
  {
    // NO CONSENT on any channel — demonstrates the consent gate.
    id: "pat-008",
    first_name: "Bartosz",
    last_name: "Kowalski",
    email_address: "bartosz.kowalski@example.co.uk",
    mobile_phone: "+447700900008",
    use_sms: false,
    use_email: false,
    marketing: 0,
    active: true,
    site_id: "site-rv",
  },
  {
    id: "pat-009",
    first_name: "Grace",
    last_name: "Okafor",
    email_address: "grace.okafor@example.co.uk",
    mobile_phone: "+447700900009",
    use_sms: true,
    use_email: true,
    marketing: 1,
    active: true,
    site_id: "site-ng",
  },
  {
    // LAPSED: archived as lapsed, no visit in ~2 years, has historic spend.
    id: "pat-010", first_name: "Harold", last_name: "Pemberton",
    email_address: "harold.pemberton@example.co.uk", mobile_phone: "+447700900010",
    use_sms: true, use_email: true, marketing: 1, active: false,
    site_id: "site-cc", archived: true, archived_reason: "lapsed",
    dentist_recall_date: null, hygienist_recall_date: null,
  },
  {
    // OVERDUE RECALL: recall date 5+ months past, no future booking.
    id: "pat-011", first_name: "Priya", last_name: "Sharma",
    email_address: "priya.sharma@example.co.uk", mobile_phone: "+447700900011",
    use_sms: true, use_email: true, marketing: 1, active: true,
    site_id: "site-rv", archived: false, archived_reason: null,
    dentist_recall_date: "2026-01-05T00:00:00Z", hygienist_recall_date: null,
  },
  {
    // STALLED PLAN: open high-value plan accepted ~200 days ago (see plan-010).
    id: "pat-012", first_name: "Marcus", last_name: "Bennett",
    email_address: "marcus.bennett@example.co.uk", mobile_phone: "+447700900012",
    use_sms: true, use_email: false, marketing: 1, active: true,
    site_id: "site-ng", archived: false, archived_reason: null,
    dentist_recall_date: null, hygienist_recall_date: null,
  },
];

// --- Treatment plans ------------------------------------------------------
// accepted_at chosen relative to 2026-06-18.
export const MOCK_TREATMENT_PLANS: MockTreatmentPlan[] = [
  // --- STALLED: high value, outstanding == planned, accepted 40-120 days ago ---
  {
    id: "plan-001",
    patient_id: "pat-001",
    site_id: "site-cc",
    name: "Invisalign full arch (upper + lower)",
    planned_private_treatment_value: 4500,
    amount_outstanding: 4500,
    accepted_at: "2026-03-02T10:15:00Z", // ~108 days before 2026-06-18
    updated_at: "2026-06-15T14:20:00Z",
  },
  {
    id: "plan-002",
    patient_id: "pat-002",
    site_id: "site-rv",
    name: "Implant + crown (UR6)",
    planned_private_treatment_value: 3200,
    amount_outstanding: 3200,
    accepted_at: "2026-04-20T09:40:00Z", // ~59 days before
    updated_at: "2026-06-16T08:05:00Z",
  },
  {
    id: "plan-003",
    patient_id: "pat-003",
    site_id: "site-ng",
    name: "Porcelain veneers x6 (upper anteriors)",
    planned_private_treatment_value: 2800,
    amount_outstanding: 2800,
    accepted_at: "2026-05-05T11:00:00Z", // ~44 days before
    updated_at: "2026-06-14T16:45:00Z",
  },

  // --- IN_PROGRESS: partial paid (outstanding < planned), accepted recently ---
  {
    id: "plan-004",
    patient_id: "pat-004",
    site_id: "site-cc",
    name: "Composite bonding (upper 6)",
    planned_private_treatment_value: 1800,
    amount_outstanding: 600,
    accepted_at: "2026-06-02T13:30:00Z", // ~16 days before
    updated_at: "2026-06-17T10:10:00Z",
  },
  {
    id: "plan-005",
    patient_id: "pat-005",
    site_id: "site-rv",
    name: "Root canal + crown (LL6)",
    planned_private_treatment_value: 1400,
    amount_outstanding: 700,
    accepted_at: "2026-06-08T15:00:00Z", // ~10 days before
    updated_at: "2026-06-17T18:25:00Z",
  },

  // --- ACCEPTED recent: outstanding == planned, accepted < 30 days ago ---
  {
    id: "plan-006",
    patient_id: "pat-006",
    site_id: "site-ng",
    name: "Teeth whitening (home kit + in-chair)",
    planned_private_treatment_value: 650,
    amount_outstanding: 650,
    accepted_at: "2026-06-10T09:20:00Z", // ~8 days before
    updated_at: "2026-06-16T12:00:00Z",
  },
  {
    id: "plan-007",
    patient_id: "pat-007",
    site_id: "site-cc",
    name: "Single implant (LR5)",
    planned_private_treatment_value: 2400,
    amount_outstanding: 2400,
    accepted_at: "2026-05-28T14:45:00Z", // ~21 days before
    updated_at: "2026-06-15T09:30:00Z",
  },

  // --- COMPLETED: amount_outstanding == 0 ---
  {
    id: "plan-008",
    patient_id: "pat-008",
    site_id: "site-rv",
    name: "Hygiene plan + scale and polish",
    planned_private_treatment_value: 320,
    amount_outstanding: 0,
    accepted_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-06-12T11:15:00Z",
  },
  {
    id: "plan-009",
    patient_id: "pat-009",
    site_id: "site-ng",
    name: "Extraction + bridge (UL4-UL6)",
    planned_private_treatment_value: 2100,
    amount_outstanding: 0,
    accepted_at: "2026-03-18T08:50:00Z",
    updated_at: "2026-06-13T13:40:00Z",
  },
  // --- DORMANT STALLED PLAN: high-value, accepted ~200 days before 2026-06-18 ---
  {
    id: "plan-010", patient_id: "pat-012", site_id: "site-ng",
    name: "Full mouth rehabilitation", planned_private_treatment_value: 7800,
    amount_outstanding: 7800, accepted_at: "2025-12-01T10:00:00Z", updated_at: "2026-06-10T09:00:00Z",
  },
];

// --- Payment plans --------------------------------------------------------
// Kept for shape-fidelity with the real Dentally /v1/payment_plans endpoint.
// The sync reads outstanding from the treatment plan itself, so these mirror
// the per-plan outstanding where one exists (and are simply absent otherwise).
export const MOCK_PAYMENT_PLANS: MockPaymentPlan[] = MOCK_TREATMENT_PLANS.filter(
  (p) => p.amount_outstanding > 0,
).map((p, idx) => ({
  id: `pp-${String(idx + 1).padStart(3, "0")}`,
  patient_id: p.patient_id,
  outstanding: p.amount_outstanding,
}));

export interface MockAppointment {
  id: string;
  patient_id: string;
  site_id: string;
  start_time: string; // ISO
  state: string;
  // Diary fields (optional; older fixtures that only drive last-visit omit them).
  patient_name?: string;
  reason?: string;
  practitioner?: string;
  duration?: number; // minutes
}

export interface MockInvoice {
  id: string;
  patient_id: string;
  paid: number;
}

// Appointment history. Past visits set "last visit"; a future one marks an
// existing booking (which disqualifies a patient from the dormant book).
export const MOCK_APPOINTMENTS: MockAppointment[] = [
  // Active patients — recent past visit, no future booking → not dormant.
  { id: "appt-002a", patient_id: "pat-002", site_id: "site-rv",  start_time: "2026-05-15T10:00:00Z", state: "completed" },
  { id: "appt-003a", patient_id: "pat-003", site_id: "site-ng",  start_time: "2026-05-15T10:00:00Z", state: "completed" },
  { id: "appt-004a", patient_id: "pat-004", site_id: "site-cc",  start_time: "2026-05-15T10:00:00Z", state: "completed" },
  { id: "appt-005a", patient_id: "pat-005", site_id: "site-rv",  start_time: "2026-05-15T10:00:00Z", state: "completed" },
  { id: "appt-006a", patient_id: "pat-006", site_id: "site-ng",  start_time: "2026-05-15T10:00:00Z", state: "completed" },
  { id: "appt-007a", patient_id: "pat-007", site_id: "site-cc",  start_time: "2026-05-15T10:00:00Z", state: "completed" },
  { id: "appt-008a", patient_id: "pat-008", site_id: "site-rv",  start_time: "2026-05-15T10:00:00Z", state: "completed" },
  { id: "appt-009a", patient_id: "pat-009", site_id: "site-ng",  start_time: "2026-05-15T10:00:00Z", state: "completed" },
  // Dormant patients.
  { id: "appt-010a", patient_id: "pat-010", site_id: "site-cc", start_time: "2024-05-10T09:00:00Z", state: "completed" },
  { id: "appt-011a", patient_id: "pat-011", site_id: "site-rv", start_time: "2025-07-02T11:30:00Z", state: "completed" },
  { id: "appt-012a", patient_id: "pat-012", site_id: "site-ng", start_time: "2025-12-01T10:00:00Z", state: "completed" },
  // An active patient WITH a future booking (must NOT appear in the dormant book).
  { id: "appt-001a", patient_id: "pat-001", site_id: "site-cc", start_time: "2026-07-20T10:00:00Z", state: "booked" },

  // --- Diary fixtures (relative to NOW = 2026-06-18, a Thursday) -----------
  // A populated week so the Calendar and Today views are meaningful. These
  // carry the optional diary fields. Walk-in / new patients use synthetic ids.
  // Today (Thu 2026-06-18)
  { id: "appt-d01", patient_id: "pat-004", patient_name: "Callum Fraser",    site_id: "site-cc", start_time: "2026-06-18T08:00:00Z", duration: 30, state: "completed",     reason: "Checkup",          practitioner: "Dr James Shah" },
  { id: "appt-d02", patient_id: "pat-007", patient_name: "Megan Lloyd",      site_id: "site-cc", start_time: "2026-06-18T09:30:00Z", duration: 60, state: "booked",        reason: "Implant consult",  practitioner: "Dr James Shah" },
  { id: "appt-d03", patient_id: "new-101", patient_name: "Daniel Okonkwo",   site_id: "site-cc", start_time: "2026-06-18T13:00:00Z", duration: 30, state: "booked",        reason: "New patient exam", practitioner: "Dr James Shah" },
  { id: "appt-d04", patient_id: "pat-001", patient_name: "Eleanor Whitfield",site_id: "site-cc", start_time: "2026-06-18T15:00:00Z", duration: 30, state: "booked",        reason: "Invisalign review",practitioner: "Dr Priya Adeyemi" },
  { id: "appt-d05", patient_id: "pat-002", patient_name: "Rajesh Patel",     site_id: "site-rv", start_time: "2026-06-18T08:30:00Z", duration: 30, state: "completed",     reason: "Hygiene",          practitioner: "Sarah Okoro (Hygienist)" },
  { id: "appt-d06", patient_id: "pat-005", patient_name: "Aisha Begum",      site_id: "site-rv", start_time: "2026-06-18T10:00:00Z", duration: 60, state: "booked",        reason: "Root canal review",practitioner: "Dr Priya Adeyemi" },
  { id: "appt-d07", patient_id: "pat-008", patient_name: "Bartosz Kowalski", site_id: "site-rv", start_time: "2026-06-18T12:00:00Z", duration: 30, state: "did_not_attend",reason: "Filling",         practitioner: "Dr James Shah" },
  { id: "appt-d08", patient_id: "new-102", patient_name: "Grace Bello",      site_id: "site-rv", start_time: "2026-06-18T14:00:00Z", duration: 15, state: "booked",        reason: "Emergency",        practitioner: "Dr Priya Adeyemi" },
  { id: "appt-d09", patient_id: "pat-003", patient_name: "Sophie Armstrong", site_id: "site-ng", start_time: "2026-06-18T09:00:00Z", duration: 60, state: "booked",        reason: "Veneers review",   practitioner: "Dr Priya Adeyemi" },
  { id: "appt-d10", patient_id: "pat-009", patient_name: "Grace Okafor",     site_id: "site-ng", start_time: "2026-06-18T11:00:00Z", duration: 30, state: "booked",        reason: "Checkup",          practitioner: "Dr James Shah" },
  { id: "appt-d11", patient_id: "pat-006", patient_name: "Thomas Hargreaves",site_id: "site-ng", start_time: "2026-06-18T15:30:00Z", duration: 30, state: "booked",        reason: "Whitening",        practitioner: "Sarah Okoro (Hygienist)" },
  // Earlier this week (completed)
  { id: "appt-d12", patient_id: "pat-004", patient_name: "Callum Fraser",    site_id: "site-cc", start_time: "2026-06-16T10:00:00Z", duration: 30, state: "completed",     reason: "Filling",          practitioner: "Dr James Shah" },
  { id: "appt-d13", patient_id: "pat-002", patient_name: "Rajesh Patel",     site_id: "site-rv", start_time: "2026-06-17T14:00:00Z", duration: 60, state: "completed",     reason: "Implant fit",      practitioner: "Dr Priya Adeyemi" },
  // Coming up (Fri 2026-06-19 and next week)
  { id: "appt-d14", patient_id: "pat-007", patient_name: "Megan Lloyd",      site_id: "site-cc", start_time: "2026-06-19T09:00:00Z", duration: 30, state: "booked",        reason: "Implant fit",      practitioner: "Dr James Shah" },
  { id: "appt-d15", patient_id: "new-103", patient_name: "Olivia Hughes",    site_id: "site-ng", start_time: "2026-06-19T11:30:00Z", duration: 30, state: "booked",        reason: "New patient exam", practitioner: "Dr Priya Adeyemi" },
  { id: "appt-d16", patient_id: "pat-005", patient_name: "Aisha Begum",      site_id: "site-rv", start_time: "2026-06-22T11:00:00Z", duration: 30, state: "booked",        reason: "Hygiene",          practitioner: "Sarah Okoro (Hygienist)" },
];

// Paid invoices = lifetime spend proxy.
export const MOCK_INVOICES: MockInvoice[] = [
  { id: "inv-010a", patient_id: "pat-010", paid: 1200 },
  { id: "inv-010b", patient_id: "pat-010", paid: 480 },
  { id: "inv-011a", patient_id: "pat-011", paid: 950 },
];

// --- Lookups --------------------------------------------------------------
export function findPatient(id: string): MockPatient | undefined {
  return MOCK_PATIENTS.find((p) => p.id === id);
}

export function paymentPlansForPatient(patientId: string): MockPaymentPlan[] {
  return MOCK_PAYMENT_PLANS.filter((pp) => pp.patient_id === patientId);
}

export function treatmentPlansForSite(siteId: string): MockTreatmentPlan[] {
  return MOCK_TREATMENT_PLANS.filter((p) => p.site_id === siteId);
}

export function patientsForSite(siteId: string): MockPatient[] {
  return MOCK_PATIENTS.filter((p) => p.site_id === siteId);
}
export function appointmentsForPatient(patientId: string): MockAppointment[] {
  return MOCK_APPOINTMENTS.filter((a) => a.patient_id === patientId);
}
export function appointmentsForSite(siteId: string): MockAppointment[] {
  return MOCK_APPOINTMENTS.filter((a) => a.site_id === siteId);
}
export function invoicesForPatient(patientId: string): MockInvoice[] {
  return MOCK_INVOICES.filter((i) => i.patient_id === patientId);
}
