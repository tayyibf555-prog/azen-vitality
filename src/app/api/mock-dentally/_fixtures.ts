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

import { siteIdFromDentally } from "@/lib/mock/clients";

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
  /**
   * The patient's payment plan, which is where FUNDING lives. Funding is a
   * PATIENT-level fact in Dentally, not an appointment-level one: an appointment
   * payload carries no plan at all. This practice's own live-calibrated ids are
   * 1 = NHS, 2 = Private, 47752 = UDC (src/lib/patient/profile.ts). Optional
   * because "no plan on file" is a real and common state that must resolve to
   * nothing rather than to a guessed default.
   */
  payment_plan_id?: number;
  /**
   * What a REGISTRATION actually wrote, for a patient created through POST
   * /v1/patients rather than seeded in the fixture table below.
   *
   * These three exist so the mock can echo back what it was given instead of
   * answering from the fixture generators (dobForPatient / genderForPatient), which
   * know nothing about an id they have never seen and would return null — making a
   * just-registered patient read back with no date of birth and no sex, which is not
   * what live Dentally does with a payload it has just accepted.
   *
   * `gender` is a BOOLEAN because that is the live encoding (probe 2026-08-17: 800
   * real records, 100% boolean, true = male).
   */
  date_of_birth?: string;
  gender?: boolean;
  title?: string;
}

export interface MockTreatmentPlan {
  id: string;
  patient_id: string;
  site_id: string;
  name: string;
  planned_private_treatment_value: number;
  amount_outstanding: number;
  /** ISO instant the patient accepted the plan, or NULL when they never did.
   *  Nullable since the charting screen was built: an item sitting on a plan the
   *  patient declined must not render identically to one on the live accepted plan,
   *  and that state has to be reachable in dev or it is only ever seen on live. */
  accepted_at: string | null; // ISO
  updated_at: string; // ISO
  /** ISO instant the plan was completed, or null when it is still open. Present as a
   *  FIELD on every row (even set to null) on purpose: that is how "no plans finished
   *  in this window" is told apart from "this source does not expose finish dates",
   *  which the dashboard must report as unavailable rather than as zero. */
  completed_at?: string | null;
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
  // --- RECALL CONCIERGE cohort (recall due/overdue within the 0-60 day window,
  // relative to NOW = 2026-06-18). pat-011 (164d overdue) deliberately stays in
  // reactivation's territory, demonstrating the 60-day seam from the other side.
  {
    // DUE SOON: dentist recall ~10 days out (inside the lead window).
    id: "pat-013", first_name: "Isabelle", last_name: "Moreau",
    email_address: "isabelle.moreau@example.co.uk", mobile_phone: "+447700900013",
    use_sms: true, use_email: true, marketing: 1, active: true,
    site_id: "site-cc", archived: false, archived_reason: null,
    dentist_recall_date: "2026-06-28T00:00:00Z", hygienist_recall_date: null,
  },
  {
    // HYGIENE recall ~24 days overdue; SMS consent only (no email).
    id: "pat-014", first_name: "Owen", last_name: "Davies",
    email_address: "owen.davies@example.co.uk", mobile_phone: "+447700900014",
    use_sms: true, use_email: false, marketing: 1, active: true,
    site_id: "site-rv", archived: false, archived_reason: null,
    dentist_recall_date: null, hygienist_recall_date: "2026-05-25T00:00:00Z",
  },
  {
    // BOTH recalls in window: dentist due soon, hygiene ~39 days overdue.
    // Produces two independent worklist rows / cadences.
    id: "pat-015", first_name: "Fatima", last_name: "Hassan",
    email_address: "fatima.hassan@example.co.uk", mobile_phone: "+447700900015",
    use_sms: true, use_email: true, marketing: 1, active: true,
    site_id: "site-ng", archived: false, archived_reason: null,
    dentist_recall_date: "2026-07-01T00:00:00Z", hygienist_recall_date: "2026-05-10T00:00:00Z",
  },
  {
    // NEAR THE SEAM: dentist recall ~57 days overdue (still inside the 60d grace,
    // so recall owns it; one day later it would graduate to reactivation).
    id: "pat-016", first_name: "George", last_name: "Whitmore",
    email_address: "george.whitmore@example.co.uk", mobile_phone: "+447700900016",
    use_sms: true, use_email: true, marketing: 1, active: true,
    site_id: "site-cc", archived: false, archived_reason: null,
    dentist_recall_date: "2026-04-22T00:00:00Z", hygienist_recall_date: null,
  },
  {
    // IN WINDOW but NO consent on any channel — demonstrates the recall consent gate.
    id: "pat-017", first_name: "Lucia", last_name: "Romano",
    email_address: "lucia.romano@example.co.uk", mobile_phone: "+447700900017",
    use_sms: false, use_email: false, marketing: 0, active: true,
    site_id: "site-rv", archived: false, archived_reason: null,
    dentist_recall_date: "2026-06-26T00:00:00Z", hygienist_recall_date: null,
  },
  {
    // LIVE TEST PATIENT (Tayyib Arbab). Real mobile, dentist recall due soon, SMS consent.
    id: "pat-018", first_name: "Tayyib", last_name: "Arbab",
    email_address: "tayyibf555@gmail.com", mobile_phone: "+447403097379",
    use_sms: true, use_email: true, marketing: 1, active: true,
    site_id: "site-cc", archived: false, archived_reason: null,
    dentist_recall_date: "2026-06-26T00:00:00Z", hygienist_recall_date: null,
  },
  // --- No-show defence demo cohort. Each has an upcoming appointment (added
  // relative to the present, below) and an attendance history (static, below)
  // that gives a different no-show risk band.
  {
    // HIGH risk: a run of missed appointments, never attended.
    id: "pat-019", first_name: "Liam", last_name: "Brennan",
    email_address: "liam.brennan@example.co.uk", mobile_phone: "+447700900019",
    use_sms: true, use_email: true, marketing: 1, active: true, site_id: "site-cc",
  },
  {
    // MEDIUM risk: mixed record, one prior no-show.
    id: "pat-020", first_name: "Chloe", last_name: "Davies",
    email_address: "chloe.davies@example.co.uk", mobile_phone: "+447700900020",
    use_sms: true, use_email: true, marketing: 1, active: true, site_id: "site-rv",
  },
  {
    // LOW risk: reliable attendance.
    id: "pat-021", first_name: "Sofia", last_name: "Marino",
    email_address: "sofia.marino@example.co.uk", mobile_phone: "+447700900021",
    use_sms: true, use_email: true, marketing: 1, active: true, site_id: "site-ng",
  },
  {
    // LOW risk site-cc appointment, used to demo cancellation -> waitlist fill.
    id: "pat-023", first_name: "Maya", last_name: "Sharma",
    email_address: "maya.sharma@example.co.uk", mobile_phone: "+447700900023",
    use_sms: true, use_email: true, marketing: 1, active: true, site_id: "site-cc",
  },
  // Waitlist patients wanting a sooner slot at site-cc.
  {
    id: "pat-024", first_name: "Freya", last_name: "Stewart",
    email_address: "freya.stewart@example.co.uk", mobile_phone: "+447700900024",
    use_sms: true, use_email: true, marketing: 1, active: true, site_id: "site-cc",
  },
  {
    id: "pat-025", first_name: "Noah", last_name: "Clarke",
    email_address: "noah.clarke@example.co.uk", mobile_phone: "+447700900025",
    use_sms: true, use_email: true, marketing: 1, active: true, site_id: "site-cc",
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
  // --- UNACCEPTED: presented, never accepted. accepted_at IS NULL. -----------
  // Exists for the charting screen: an item on a plan the patient declined is a
  // distinct origin there, and without a null-accepted plan in the fixtures that
  // rendering could only ever be seen against live data. Kept small in value and
  // NOT settled (amount_outstanding > 0), because the mock plans route treats a
  // zero-outstanding plan as completed, which is the one status this row must not
  // report.
  {
    id: "plan-011", patient_id: "pat-001", site_id: "site-cc",
    name: "Crown UL4 (presented, not accepted)", planned_private_treatment_value: 780,
    amount_outstanding: 780, accepted_at: null, updated_at: "2026-06-16T11:30:00Z",
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

// --- Charting: categories, treatments, treatment plan items ---------------
//
// These three back the FDI charting screen, which is a READ-ONLY MIRROR of
// Dentally. Nothing here is ever written back: there is no create route on any
// charting resource upstream and no mock write route below.
//
// SHAPE NOTES, and read this before trusting the arrays. The field NAMES come
// from developer.dentally.co; the wire SHAPES of `teeth` and `surfaces` are
// UNVERIFIED, because no probe has run against a live charted patient. So the
// rows below deliberately vary: an array of numbers, a bare string, a delimited
// string and one value the parser cannot place at all. The read layer tolerates
// all four and reports what it cannot place rather than dropping it, and this is
// where that behaviour is exercised in dev rather than discovered on live data.
//
// A CHART DRAWN FROM A PARTIAL READ IS A FALSE CLINICAL PICTURE, so every awkward
// case a real practice has is present here on purpose: whole-tooth work with no
// surfaces at all, one tooth carrying both completed and planned work, one tooth
// carrying NHS and private funding at once, a pre-existing base-chart restoration,
// an item on a plan nobody accepted, mixed permanent and deciduous dentition on one
// patient, an unrecognised surface letter, and a row whose teeth value is gibberish.
//
// No real patient names, addresses or balances from the source screenshots.

export interface MockTreatmentCategory {
  id: string;
  name: string;
}

export interface MockTreatment {
  id: string;
  /** The STAFF-facing code a dentist types to find the treatment. */
  code: string;
  name: string;
  treatment_category_id: string;
  price: number;
}

export interface MockTreatmentPlanItem {
  id: string;
  patient_id: string;
  treatment_plan_id: string | null;
  /**
   * The appointment CARD this row sits under on the plan panel, or null.
   *
   * NULL ON MOST ROWS ON PURPOSE. A live probe of production on 2026-08-02 found
   * only 17 of 100 plan items carrying one: 83% of a real patient's treatment plan
   * belongs to no appointment card at all. A fixture set where every row had a card
   * would make the "items with no appointment" group unreachable in dev, and the
   * panel would look complete on every local render while silently dropping most of
   * a real plan — the same failure that let the blank surfaces and the unparsed
   * Palmer teeth ship. The ratio below is kept deliberately close to the live one.
   */
  treatment_appointment_id: string | null;
  treatment_id: string | null;
  practitioner_id: string | null;
  /** Deliberately `unknown`: the live shape is not verified, and typing it as
   *  number[] here would quietly assert something no probe has established. */
  teeth: unknown;
  /** Deliberately `unknown`, for the same reason `teeth` is. Dentally's own
   *  documentation says surfaces are INTEGERS (1-5, and 1-8 on molars), while
   *  the observed chart reads as letter codes, so the fixtures hold both
   *  shapes: "MOD" and a bare number. Typing it as string asserted a wire
   *  shape no probe has established. */
  surfaces: unknown;
  region: string | null;
  base_chart: boolean;
  completed: boolean;
  completed_at: string | null;
  charged: boolean;
  notes: string | null;
  /** Staff wording. `patient_nomenclature` is the patient-facing twin; the chart
   *  is a staff screen and must print this one. */
  nomenclature: string;
  patient_nomenclature: string;
  price: number;
  value: number;
  duration: number;
  nhs_treatment_cat: string | null;
  uda_band: string | null;
  payment_plan_id: number | null;
  position: number;
  created_at: string;
  updated_at: string;
}

// Categories, in the order a Dentally catalogue tends to list them.
export const MOCK_TREATMENT_CATEGORIES: MockTreatmentCategory[] = [
  { id: "cat-001", name: "Diagnostic" },
  { id: "cat-002", name: "Restorative" },
  { id: "cat-003", name: "Endodontics" },
  { id: "cat-004", name: "Surgical" },
  { id: "cat-005", name: "Prosthetics" },
  { id: "cat-006", name: "Hygiene and prevention" },
  { id: "cat-007", name: "Orthodontics" },
  { id: "cat-008", name: "Cosmetic" },
];

// The catalogue. Codes follow the reference screen's own examples (0000 Bridge
// Abutment, 103 NuSmile Consultation, 121 NHS Urgent Filling).
//
// The SPREAD OF FIRST LETTERS is deliberate, not decorative: the chart's alphabet
// rail renders all 37 keys and shows an empty bucket as visibly disabled rather
// than as a live control that jumps nowhere. With names starting A, B, C, D, E, F,
// H, I, N, O, R, S, V and W, dev exercises populated AND empty buckets at once. A
// catalogue that happened to fill every letter would test only half the rail.
export const MOCK_TREATMENTS: MockTreatment[] = [
  { id: "tr-000", code: "0000", name: "Bridge Abutment", treatment_category_id: "cat-005", price: 0 },
  { id: "tr-103", code: "103", name: "NuSmile Consultation", treatment_category_id: "cat-001", price: 45 },
  { id: "tr-121", code: "121", name: "NHS Urgent Filling", treatment_category_id: "cat-002", price: 26.8 },
  { id: "tr-110", code: "110", name: "Amalgam Filling", treatment_category_id: "cat-002", price: 95 },
  { id: "tr-111", code: "111", name: "Composite Filling", treatment_category_id: "cat-002", price: 185 },
  { id: "tr-112", code: "112", name: "Crown - Porcelain", treatment_category_id: "cat-005", price: 780 },
  { id: "tr-113", code: "113", name: "Bridge - 3 unit", treatment_category_id: "cat-005", price: 1950 },
  { id: "tr-120", code: "120", name: "Denture - Full Upper", treatment_category_id: "cat-005", price: 890 },
  { id: "tr-130", code: "130", name: "Endodontic Treatment - Molar", treatment_category_id: "cat-003", price: 650 },
  { id: "tr-131", code: "131", name: "Extraction - Simple", treatment_category_id: "cat-004", price: 145 },
  { id: "tr-132", code: "132", name: "Extraction - Surgical", treatment_category_id: "cat-004", price: 320 },
  { id: "tr-140", code: "140", name: "Fissure Sealant", treatment_category_id: "cat-006", price: 35 },
  { id: "tr-141", code: "141", name: "Fluoride Varnish", treatment_category_id: "cat-006", price: 25 },
  { id: "tr-150", code: "150", name: "Hygiene - Scale and Polish", treatment_category_id: "cat-006", price: 68 },
  { id: "tr-151", code: "151", name: "Implant - Single", treatment_category_id: "cat-005", price: 2400 },
  { id: "tr-160", code: "160", name: "Inlay - Composite", treatment_category_id: "cat-002", price: 395 },
  { id: "tr-170", code: "170", name: "Onlay - Gold", treatment_category_id: "cat-002", price: 620 },
  { id: "tr-171", code: "171", name: "Orthodontic Assessment", treatment_category_id: "cat-007", price: 60 },
  { id: "tr-181", code: "181", name: "Radiograph - Bitewing", treatment_category_id: "cat-001", price: 15 },
  { id: "tr-190", code: "190", name: "Splint - Occlusal", treatment_category_id: "cat-005", price: 340 },
  { id: "tr-191", code: "191", name: "Study Models", treatment_category_id: "cat-001", price: 55 },
  { id: "tr-200", code: "200", name: "Veneer - Porcelain", treatment_category_id: "cat-008", price: 720 },
  { id: "tr-210", code: "210", name: "Whitening - Home Kit", treatment_category_id: "cat-008", price: 295 },
  { id: "tr-220", code: "220", name: "Root Surface Debridement", treatment_category_id: "cat-006", price: 120 },
];

/** Terse row builder: the fields below are the ones a case actually varies, and
 *  everything else takes a sane default, so a reader sees the CASE and not the
 *  twenty-odd identical keys around it. */
function tpi(
  id: string,
  patient_id: string,
  o: Partial<MockTreatmentPlanItem> & { nomenclature: string },
): MockTreatmentPlanItem {
  return {
    id,
    patient_id,
    treatment_plan_id: null,
    // Defaulting to NULL is the honest default: on live data most rows have no card.
    treatment_appointment_id: null,
    treatment_id: null,
    // "prac-001" HERE WAS A DEV-ONLY BLACK HOLE. /v1/practitioners and every
    // appointment in this file use ids from ROSTER ("prac-1", "prac-2", ...), so a
    // plan item's practitioner_id could NEVER match one and the panel's clinician
    // column was 100% blank locally whatever the code did. The defect it hid was
    // real on live data, and it survived three passes because the mock was tidier
    // than production in the one direction that mattered. Every plan item now names
    // a real rostered id, and the awkward cases below name deliberately awkward ones.
    practitioner_id: "prac-1",
    teeth: [],
    surfaces: "",
    region: null,
    base_chart: false,
    completed: false,
    completed_at: null,
    charged: false,
    notes: null,
    patient_nomenclature: o.nomenclature,
    price: 0,
    value: 0,
    duration: 20,
    nhs_treatment_cat: null,
    uda_band: null,
    payment_plan_id: 2,
    position: 1,
    created_at: "2026-05-02T09:00:00Z",
    updated_at: "2026-06-16T09:00:00Z",
    ...o,
  };
}

export const MOCK_TREATMENT_PLAN_ITEMS: MockTreatmentPlanItem[] = [
  // === pat-001 (site-cc): the rich chart ==================================
  // A multi-surface MOD on an upper right first molar, done and charged.
  tpi("tpi-001", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-111", nomenclature: "Composite Filling",
    teeth: [16], surfaces: "MOD", region: "UR", completed: true, completed_at: "2026-05-14T10:20:00Z",
    charged: true, price: 185, value: 185, duration: 40, payment_plan_id: 2, position: 1,
    notes: "MOD composite, shade A2.",
  }),
  // THE SAME TOOTH, planned rather than completed, and on NHS rather than private.
  // Two things at once, both of which the screen has to keep apart: completed vs
  // planned on one tooth, and a funding rail that has to draw TWO codes for tooth 16.
  //
  // ON CARD ta-001, which also carries a PRIVATE row (tpi-020). One card holding
  // both funding codes is the ordinary case on a real plan, and a card footer that
  // rolled the two into one number would be a claim about a claim.
  // Worked by a DIFFERENT clinician from the one the card's diary appointment is
  // booked with (appt-001a is prac-1, Dana Hale). That is ordinary - a card is
  // booked with one person and a line on it can be another's - and it is the case
  // that proves the initials come from the item's own practitioner_id rather than
  // from the card heading above it.
  tpi("tpi-002", "pat-001", {
    treatment_plan_id: "plan-001", treatment_appointment_id: "ta-001",
    practitioner_id: "prac-2",
    treatment_id: "tr-121", nomenclature: "NHS Urgent Filling",
    patient_nomenclature: "Filling", teeth: [16], surfaces: "B", region: "UR",
    price: 26.8, value: 26.8, payment_plan_id: 1, nhs_treatment_cat: "Band 2", uda_band: "2", position: 3,
  }),
  // === ta-001's other two rows, mirroring the reference screenshot exactly ====
  // A ZERO-PRICE row. £0.00 is a real, ordinary value on a plan (an image taken as
  // part of a band, a bridge abutment, an NHS item covered by the UDA) and it is
  // NOT the same as "no price recorded". A footer that skipped zero rows, or a cell
  // that rendered 0 as blank, would under-count the card and read as a missing row.
  tpi("tpi-020", "pat-001", {
    treatment_plan_id: "plan-001", treatment_appointment_id: "ta-001",
    treatment_id: "tr-181", nomenclature: "Intraoral Periapical Image",
    teeth: [], surfaces: "", price: 0, value: 0, duration: 0, payment_plan_id: 2, position: 1,
  }),
  // NHS, zero price, 15 minutes. Its money sits in the UDA band, not in `price`.
  tpi("tpi-021", "pat-001", {
    treatment_plan_id: "plan-001", treatment_appointment_id: "ta-001",
    treatment_id: "tr-103", nomenclature: "Urgent Assessment - Problem Focused",
    teeth: [], surfaces: "", price: 0, value: 0, duration: 15,
    payment_plan_id: 1, nhs_treatment_cat: "Band 1", uda_band: "1", position: 2,
  }),
  // Occlusal-only findings across the upper anteriors, mirroring the observed
  // Dentally screenshot. Four separate rows, as Dentally holds them.
  tpi("tpi-003", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-111", nomenclature: "Composite Filling",
    teeth: [11], surfaces: "O", price: 185, value: 185, position: 3,
  }),
  tpi("tpi-004", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-111", nomenclature: "Composite Filling",
    teeth: [12], surfaces: "O", price: 185, value: 185, position: 4,
  }),
  tpi("tpi-005", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-111", nomenclature: "Composite Filling",
    teeth: [21], surfaces: "O", price: 185, value: 185, position: 5,
  }),
  tpi("tpi-006", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-111", nomenclature: "Composite Filling",
    teeth: [22], surfaces: "O", price: 185, value: 185, position: 6,
  }),
  // WHOLE-TOOTH WORK: a planned extraction carries no surfaces at all. A renderer
  // that only draws surfaces draws this as a clean, unmarked tooth, which is the
  // most direct route this screen has to a wrong-site event. It is in the fixtures
  // so that failure is visible on the first local render.
  //
  // ON CARD ta-002, whose linked diary appointment DOES NOT EXIST. The card header
  // therefore has no date, time or practitioner, and the panel must say why rather
  // than render an undated card that reads as "not yet scheduled".
  tpi("tpi-007", "pat-001", {
    treatment_plan_id: "plan-001", treatment_appointment_id: "ta-002",
    treatment_id: "tr-131", nomenclature: "Extraction - Simple",
    teeth: [26], surfaces: "", price: 145, value: 145, duration: 30, position: 1,
    notes: "Unrestorable. Discussed replacement options.",
  }),
  // A multi-tooth item: one bridge spanning three lower left teeth, again with no
  // surfaces. It must appear on ALL THREE teeth, not just the first abutment.
  tpi("tpi-008", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-113", nomenclature: "Bridge - 3 unit",
    teeth: [34, 35, 36], surfaces: "", price: 1950, value: 1950, duration: 90, position: 8,
  }),
  // BASE CHART: a pre-existing restoration Dentally recorded as the starting state
  // rather than as planned or completed treatment.
  // ALSO THE INACTIVE-CLINICIAN CASE. prac-9 is ROSTER's active:false row, and a
  // restoration placed in 2019 by a clinician who has since left is exactly the
  // shape of it. The panel read must NOT filter /v1/practitioners on `active` the
  // way the booking picker does, or the oldest entries on a record - the ones a
  // clinician is most likely to be checking - lose their attribution.
  tpi("tpi-009", "pat-001", {
    treatment_id: "tr-110", nomenclature: "Amalgam Filling", teeth: [46], surfaces: "MO",
    practitioner_id: "prac-9",
    base_chart: true, completed: true, completed_at: "2019-03-11T00:00:00Z",
    price: 0, value: 0, payment_plan_id: 1, position: 9, notes: "Pre-existing on registration.",
  }),
  // AN UNRECOGNISED SURFACE LETTER. "X" is not one of the five regions. It must be
  // shown as an unrecognised letter, never silently dropped: a swallowed letter is
  // a surface a clinician believes was not recorded.
  tpi("tpi-010", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-160", nomenclature: "Inlay - Composite",
    teeth: [47], surfaces: "MODX", price: 395, value: 395, position: 10,
  }),
  // DELIBERATELY UNPARSEABLE TEETH. This row exists to exercise the unplaced
  // affordance: it must be counted and listed with its raw value shown, never
  // dropped.
  //
  // It used to say "UR6", which is Palmer notation and which parseTeeth now
  // CONVERTS, because DENTALLY.md's correction says Palmer is what Dentally
  // actually stores. A fixture whose whole job is to be unreadable has to hold
  // something genuinely unreadable, so it holds a free-text value instead.
  tpi("tpi-011", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-190", nomenclature: "Splint - Occlusal",
    teeth: "whole arch", surfaces: "", price: 340, value: 340, position: 11,
  }),
  // PALMER NOTATION, WHICH IS WHAT LIVE DENTALLY SENDS. It must place on tooth 16
  // exactly as [16] does, or every row on every live patient lands in unplaced
  // and the arch draws thirty-two clean teeth.
  tpi("tpi-015", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-110", nomenclature: "Fissure Sealant",
    teeth: "UL7", surfaces: "O", price: 45, value: 45, duration: 15, position: 14,
  }),
  // A NUMERIC SURFACE, which is what Dentally's own documentation says the field
  // holds ("numbered 1-5 ... and 1-8 for molar teeth"). We do not know which
  // region each index is and will not guess, so this must render as a marked
  // tooth with the value shown, and must NOT be mistaken for a whole-tooth
  // finding such as an extraction.
  tpi("tpi-016", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-160", nomenclature: "Composite - Posterior",
    teeth: [37], surfaces: 6, price: 210, value: 210, duration: 40, position: 15,
  }),
  // ON A PLAN THE PATIENT NEVER ACCEPTED (plan-011, accepted_at null). This must
  // not render identically to the accepted plan's work above.
  // A PRACTITIONER ID THE PRACTITIONER LIST DOES NOT HOLD. Ordinary after a merge,
  // or when the clinician sits at another site. Dentally DID record who planned
  // this crown, so the initials cell must say that we could not look them up rather
  // than go blank - a blank on this table means "Dentally sent nothing here", which
  // for this row would be false.
  tpi("tpi-012", "pat-001", {
    treatment_plan_id: "plan-011", treatment_id: "tr-112", nomenclature: "Crown - Porcelain",
    practitioner_id: "prac-not-on-this-site",
    teeth: [24], surfaces: "MOD", price: 780, value: 780, duration: 60, position: 1,
  }),
  // Two tolerance cases: a BARE STRING and a DELIMITED STRING. Both must parse to
  // the same thing an array of numbers would.
  tpi("tpi-013", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-181", nomenclature: "Radiograph - Bitewing",
    teeth: "17", surfaces: "", price: 15, value: 15, duration: 10, completed: true,
    completed_at: "2026-05-14T10:05:00Z", charged: true, position: 12,
  }),
  // NO PRACTITIONER AT ALL. The one case where an empty initials cell is the true
  // answer, kept beside the unresolvable row above so the two states are visibly
  // different on one screen rather than only in a test.
  tpi("tpi-014", "pat-001", {
    treatment_plan_id: "plan-001", treatment_id: "tr-200", nomenclature: "Veneer - Porcelain",
    practitioner_id: null,
    teeth: "13,23", surfaces: "B", price: 1440, value: 1440, duration: 60, position: 13,
  }),

  // === pat-004 (site-cc): MIXED DENTITION ==================================
  // Permanent AND deciduous work on one patient. Whichever arch the chart is
  // showing, the other one's items must be counted rather than silently gone.
  //
  // EVERY ROW HERE HAS treatment_appointment_id null, and pat-004 has no treatment
  // appointments at all. That is the majority case on live data (83% of items), and
  // it is the one a panel built as pure "Appt. 1 / Appt. 2" cards renders as an
  // empty screen for a patient with a full plan.
  //
  // The ids used to be tpi-015..tpi-018, which COLLIDED with pat-001's tpi-015 and
  // tpi-016. Nothing keyed on them until the plan panel, which keys rows by id;
  // treatmentPlanItemsForPlan() also crosses patients. Renumbered rather than left
  // as a latent duplicate-key bug.
  tpi("tpi-041", "pat-004", {
    treatment_plan_id: "plan-004", treatment_id: "tr-111", nomenclature: "Composite Filling",
    teeth: [36], surfaces: "O", completed: true, completed_at: "2026-06-04T14:10:00Z",
    charged: true, price: 185, value: 185, position: 1,
  }),
  tpi("tpi-042", "pat-004", {
    treatment_plan_id: "plan-004", treatment_id: "tr-140", nomenclature: "Fissure Sealant",
    teeth: [55], surfaces: "O", price: 35, value: 35, duration: 15, payment_plan_id: 1,
    nhs_treatment_cat: "Band 1", uda_band: "1", position: 2,
  }),
  tpi("tpi-043", "pat-004", {
    treatment_plan_id: "plan-004", treatment_id: "tr-111", nomenclature: "Composite Filling",
    teeth: [74], surfaces: "MO", price: 185, value: 185, position: 3,
  }),
  tpi("tpi-044", "pat-004", {
    treatment_plan_id: "plan-004", treatment_id: "tr-131", nomenclature: "Extraction - Simple",
    teeth: [85], surfaces: "", price: 145, value: 145, duration: 30, position: 4,
  }),
];

// --- Treatment appointments: the plan panel's cards -----------------------
//
// One row per card on the treatment plan panel. READ ONLY, like every other
// charting fixture: there is no create route on /v1/treatment_appointments
// upstream and there is no mock write route below, so `+ add appointment` renders
// disabled with its reason stated.
//
// FIELD NOTES, from PLAN-PANEL.md §2 (verified live 2026-08-02):
//   - `position` IS the card number, zero-based. position 0 renders as "Appt. 1".
//     Numbering is not invented from array order.
//   - `notes` is the note printed in the card header. Readable; the Draft/mic
//     editing affordances beside it are gated.
//   - `appointment_id` links the card to a DIARY appointment, and that is where the
//     header's date, time and practitioner come from — NOT from this object, which
//     carries none of the three.
//
// THE DISTRIBUTION HERE IS DELIBERATELY AWKWARD, because production is. A mock
// that is tidier than production is how the blank-surfaces bug survived local dev:
//   - ta-001 resolves cleanly (appt-001a is a real diary row).
//   - ta-002 names an appointment id that DOES NOT EXIST. Dangling references are
//     ordinary after a cancellation or a merge, and the panel must say the header
//     could not be resolved rather than draw an undated card.
//   - ta-003 carries NO appointment_id at all and no items. A card that was created
//     but never booked, and never filled. Two states a reader must be able to tell
//     apart from ta-002's, and from "this patient has no cards".
export interface MockTreatmentAppointment {
  id: string;
  patient_id: string;
  treatment_plan_id: string | null;
  /** ZERO-BASED card number. position 0 is "Appt. 1". */
  position: number;
  /** The note in the card header. */
  notes: string | null;
  bookable: boolean;
  /** The DIARY appointment this card is booked as, or null when it is not booked. */
  appointment_id: string | null;
}

export const MOCK_TREATMENT_APPOINTMENTS: MockTreatmentAppointment[] = [
  {
    id: "ta-001", patient_id: "pat-001", treatment_plan_id: "plan-001", position: 0,
    notes: "Patient anxious about the assessment - allow extra chair time.",
    bookable: true, appointment_id: "appt-001a",
  },
  {
    id: "ta-002", patient_id: "pat-001", treatment_plan_id: "plan-001", position: 1,
    notes: null, bookable: true,
    // Deliberately dangling: no appointment with this id exists in MOCK_APPOINTMENTS.
    appointment_id: "appt-does-not-exist",
  },
  {
    id: "ta-003", patient_id: "pat-001", treatment_plan_id: "plan-001", position: 2,
    notes: "To be booked once the RCT is reviewed.", bookable: true, appointment_id: null,
  },
];

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
  /** Live Dentally shape: the appointment's practitioner id, which the dashboard's
   *  person filter and its per-clinician UDA breakdown match on. Older fixtures
   *  carried only the display name, so this is optional. */
  practitioner_id?: string;
  /** Free text typed onto the booking, shown under the reason in the dashboard's
   *  appointment list. Field NAME unverified against live; readers must tolerate
   *  its absence rather than assume it. */
  notes?: string;
}

export interface MockInvoice {
  id: string;
  patient_id: string;
  // Mirrors the REAL Dentally invoice shape so the outstanding scan exercises the live
  // code path: `amount` (gross), `amount_outstanding` (balance owed, net of partial
  // payments), `paid` (a BOOLEAN, fully paid?), `status`. outstanding = amount_outstanding.
  amount: number;
  amount_outstanding: number;
  paid: boolean;
  status: string;
  /** Bare YYYY-MM-DD the invoice was raised. Optional because the hand-written rows
   *  below carry no date: they exist to give a patient a balance, not to be totalled
   *  over a window. The dashboard's INVOICED panel counts only dated invoices and
   *  discloses how many it had to leave out. */
  date?: string;
}

// Appointment history. Past visits set "last visit"; a future one marks an
// existing booking (which disqualifies a patient from the dormant book).
export const MOCK_APPOINTMENTS: MockAppointment[] = [
  // Active patients — recent past visit, no future booking → not dormant.
  { id: "appt-002a", patient_id: "pat-002", site_id: "site-rv",  start_time: "2026-05-15T10:00:00Z", state: "Completed" },
  { id: "appt-003a", patient_id: "pat-003", site_id: "site-ng",  start_time: "2026-05-15T10:00:00Z", state: "Completed" },
  { id: "appt-004a", patient_id: "pat-004", site_id: "site-cc",  start_time: "2026-05-15T10:00:00Z", state: "Completed" },
  { id: "appt-005a", patient_id: "pat-005", site_id: "site-rv",  start_time: "2026-05-15T10:00:00Z", state: "Completed" },
  { id: "appt-006a", patient_id: "pat-006", site_id: "site-ng",  start_time: "2026-05-15T10:00:00Z", state: "Completed" },
  { id: "appt-007a", patient_id: "pat-007", site_id: "site-cc",  start_time: "2026-05-15T10:00:00Z", state: "Completed" },
  { id: "appt-008a", patient_id: "pat-008", site_id: "site-rv",  start_time: "2026-05-15T10:00:00Z", state: "Completed" },
  { id: "appt-009a", patient_id: "pat-009", site_id: "site-ng",  start_time: "2026-05-15T10:00:00Z", state: "Completed" },
  // Dormant patients.
  { id: "appt-010a", patient_id: "pat-010", site_id: "site-cc", start_time: "2024-05-10T09:00:00Z", state: "Completed" },
  { id: "appt-011a", patient_id: "pat-011", site_id: "site-rv", start_time: "2025-07-02T11:30:00Z", state: "Completed" },
  { id: "appt-012a", patient_id: "pat-012", site_id: "site-ng", start_time: "2025-12-01T10:00:00Z", state: "Completed" },
  // Recall concierge cohort — a past visit each, no future booking, recall now due/overdue.
  { id: "appt-013a", patient_id: "pat-013", site_id: "site-cc", start_time: "2026-01-10T10:00:00Z", state: "Completed" },
  { id: "appt-014a", patient_id: "pat-014", site_id: "site-rv", start_time: "2025-11-20T10:00:00Z", state: "Completed" },
  { id: "appt-015a", patient_id: "pat-015", site_id: "site-ng", start_time: "2025-12-15T10:00:00Z", state: "Completed" },
  { id: "appt-016a", patient_id: "pat-016", site_id: "site-cc", start_time: "2025-10-15T10:00:00Z", state: "Completed" },
  { id: "appt-017a", patient_id: "pat-017", site_id: "site-rv", start_time: "2026-01-05T10:00:00Z", state: "Completed" },
  { id: "appt-018a", patient_id: "pat-018", site_id: "site-cc", start_time: "2025-12-20T10:00:00Z", state: "Completed" },
  // An active patient WITH a future booking (must NOT appear in the dormant book).
  //
  // ALSO the diary appointment that plan-panel card ta-001 is booked as, which is
  // why it carries a duration and a practitioner: the card HEADER's date, time and
  // clinician are read off this row, not off the treatment_appointment. Strip these
  // and ta-001 renders with a blank clinician on a booked appointment.
  { id: "appt-001a", patient_id: "pat-001", site_id: "site-cc", start_time: "2026-07-20T10:00:00Z", state: "booked",
    duration: 45, reason: "Urgent assessment", practitioner: "Dana Hale", practitioner_id: "prac-1" },

  // --- Diary fixtures (relative to NOW = 2026-06-18, a Thursday) -----------
  // A populated week so the Calendar and Today views are meaningful. These
  // carry the optional diary fields. Walk-in / new patients use synthetic ids.
  // Today (Thu 2026-06-18)
  { id: "appt-d01", patient_id: "pat-004", patient_name: "Callum Fraser",    site_id: "site-cc", start_time: "2026-06-18T08:00:00Z", duration: 30, state: "Completed",     reason: "Checkup",          practitioner: "Dr James Shah" },
  { id: "appt-d02", patient_id: "pat-007", patient_name: "Megan Lloyd",      site_id: "site-cc", start_time: "2026-06-18T09:30:00Z", duration: 60, state: "booked",        reason: "Implant consult",  practitioner: "Dr James Shah" },
  { id: "appt-d03", patient_id: "new-101", patient_name: "Daniel Okonkwo",   site_id: "site-cc", start_time: "2026-06-18T13:00:00Z", duration: 30, state: "booked",        reason: "New patient exam", practitioner: "Dr James Shah" },
  { id: "appt-d04", patient_id: "pat-001", patient_name: "Eleanor Whitfield",site_id: "site-cc", start_time: "2026-06-18T15:00:00Z", duration: 30, state: "booked",        reason: "Invisalign review",practitioner: "Dr Priya Adeyemi" },
  { id: "appt-d05", patient_id: "pat-002", patient_name: "Rajesh Patel",     site_id: "site-rv", start_time: "2026-06-18T08:30:00Z", duration: 30, state: "Completed",     reason: "Hygiene",          practitioner: "Sarah Okoro (Hygienist)" },
  { id: "appt-d06", patient_id: "pat-005", patient_name: "Aisha Begum",      site_id: "site-rv", start_time: "2026-06-18T10:00:00Z", duration: 60, state: "booked",        reason: "Root canal review",practitioner: "Dr Priya Adeyemi" },
  { id: "appt-d07", patient_id: "pat-008", patient_name: "Bartosz Kowalski", site_id: "site-rv", start_time: "2026-06-18T12:00:00Z", duration: 30, state: "Did not attend",reason: "Filling",         practitioner: "Dr James Shah" },
  { id: "appt-d08", patient_id: "new-102", patient_name: "Grace Bello",      site_id: "site-rv", start_time: "2026-06-18T14:00:00Z", duration: 15, state: "booked",        reason: "Emergency",        practitioner: "Dr Priya Adeyemi" },
  { id: "appt-d09", patient_id: "pat-003", patient_name: "Sophie Armstrong", site_id: "site-ng", start_time: "2026-06-18T09:00:00Z", duration: 60, state: "booked",        reason: "Veneers review",   practitioner: "Dr Priya Adeyemi" },
  { id: "appt-d10", patient_id: "pat-009", patient_name: "Grace Okafor",     site_id: "site-ng", start_time: "2026-06-18T11:00:00Z", duration: 30, state: "booked",        reason: "Checkup",          practitioner: "Dr James Shah" },
  { id: "appt-d11", patient_id: "pat-006", patient_name: "Thomas Hargreaves",site_id: "site-ng", start_time: "2026-06-18T15:30:00Z", duration: 30, state: "booked",        reason: "Whitening",        practitioner: "Sarah Okoro (Hygienist)" },
  // Earlier this week (completed)
  { id: "appt-d12", patient_id: "pat-004", patient_name: "Callum Fraser",    site_id: "site-cc", start_time: "2026-06-16T10:00:00Z", duration: 30, state: "Completed",     reason: "Filling",          practitioner: "Dr James Shah" },
  { id: "appt-d13", patient_id: "pat-002", patient_name: "Rajesh Patel",     site_id: "site-rv", start_time: "2026-06-17T14:00:00Z", duration: 60, state: "Completed",     reason: "Implant fit",      practitioner: "Dr Priya Adeyemi" },
  // Coming up (Fri 2026-06-19 and next week)
  { id: "appt-d14", patient_id: "pat-007", patient_name: "Megan Lloyd",      site_id: "site-cc", start_time: "2026-06-19T09:00:00Z", duration: 30, state: "booked",        reason: "Implant fit",      practitioner: "Dr James Shah" },
  { id: "appt-d15", patient_id: "new-103", patient_name: "Olivia Hughes",    site_id: "site-ng", start_time: "2026-06-19T11:30:00Z", duration: 30, state: "booked",        reason: "New patient exam", practitioner: "Dr Priya Adeyemi" },
  { id: "appt-d16", patient_id: "pat-005", patient_name: "Aisha Begum",      site_id: "site-rv", start_time: "2026-06-22T11:00:00Z", duration: 30, state: "booked",        reason: "Hygiene",          practitioner: "Sarah Okoro (Hygienist)" },

  // --- No-show defence: attendance history that sets each patient's risk band ---
  { id: "appt-019h1", patient_id: "pat-019", site_id: "site-cc", start_time: "2026-02-10T09:00:00Z", state: "Did not attend" },
  { id: "appt-019h2", patient_id: "pat-019", site_id: "site-cc", start_time: "2026-03-15T09:00:00Z", state: "Did not attend" },
  { id: "appt-019h3", patient_id: "pat-019", site_id: "site-cc", start_time: "2026-04-20T09:00:00Z", state: "Did not attend" },
  { id: "appt-020h1", patient_id: "pat-020", site_id: "site-rv", start_time: "2026-03-01T10:00:00Z", state: "Completed" },
  { id: "appt-020h2", patient_id: "pat-020", site_id: "site-rv", start_time: "2026-04-10T10:00:00Z", state: "Did not attend" },
  { id: "appt-021h1", patient_id: "pat-021", site_id: "site-ng", start_time: "2026-02-01T11:00:00Z", state: "Completed" },
  { id: "appt-021h2", patient_id: "pat-021", site_id: "site-ng", start_time: "2026-04-01T11:00:00Z", state: "Completed" },
  { id: "appt-023h1", patient_id: "pat-023", site_id: "site-cc", start_time: "2026-03-20T14:00:00Z", state: "Completed" },
];

// No-show defence demo: upcoming appointments anchored to the present so the
// worklist is always populated regardless of today's date. Risk varies by each
// patient's attendance history above.
function noshowUpcomingAppointments(): MockAppointment[] {
  const now = Date.now();
  const at = (days: number, hour: number): string => {
    const d = new Date(now + days * 86_400_000);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  return [
    { id: "appt-ns19", patient_id: "pat-019", patient_name: "Liam Brennan", site_id: "site-cc", start_time: at(2, 9), duration: 30, state: "booked", reason: "Checkup", practitioner: "Dr James Shah" },
    { id: "appt-ns20", patient_id: "pat-020", patient_name: "Chloe Davies", site_id: "site-rv", start_time: at(3, 10), duration: 30, state: "booked", reason: "Hygiene", practitioner: "Sarah Okoro (Hygienist)" },
    { id: "appt-ns21", patient_id: "pat-021", patient_name: "Sofia Marino", site_id: "site-ng", start_time: at(4, 11), duration: 30, state: "booked", reason: "Checkup", practitioner: "Dr Priya Adeyemi" },
    { id: "appt-ns23", patient_id: "pat-023", patient_name: "Maya Sharma", site_id: "site-cc", start_time: at(5, 14), duration: 30, state: "booked", reason: "Filling", practitioner: "Dr James Shah" },
  ];
}
MOCK_APPOINTMENTS.push(...noshowUpcomingAppointments());

// Invoices. Settled ones (paid == total) are the lifetime-spend proxy; the block
// below carries a real balance (paid < total) and drives the Payments outstanding
// scan the way real Dentally does (balances live on invoices, not on plans).
export const MOCK_INVOICES: MockInvoice[] = [
  // Settled (amount_outstanding 0, paid true): the lifetime-spend history.
  { id: "inv-001a", patient_id: "pat-001", amount: 1340, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-002a", patient_id: "pat-002", amount: 1850, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-002b", patient_id: "pat-002", amount: 640, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-003a", patient_id: "pat-003", amount: 980, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-004a", patient_id: "pat-004", amount: 1200, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-005a", patient_id: "pat-005", amount: 700, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-006a", patient_id: "pat-006", amount: 450, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-007a", patient_id: "pat-007", amount: 280, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-008a", patient_id: "pat-008", amount: 320, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-009a", patient_id: "pat-009", amount: 2100, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-010a", patient_id: "pat-010", amount: 1200, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-010b", patient_id: "pat-010", amount: 480, amount_outstanding: 0, paid: true, status: "paid" },
  { id: "inv-011a", patient_id: "pat-011", amount: 950, amount_outstanding: 0, paid: true, status: "paid" },
  // Outstanding (amount_outstanding > 0, paid false): a real balance owed. Drives Payments.
  { id: "inv-002c", patient_id: "pat-002", amount: 2000, amount_outstanding: 1500, paid: false, status: "new" },
  { id: "inv-005b", patient_id: "pat-005", amount: 850, amount_outstanding: 850, paid: false, status: "new" },
  { id: "inv-009b", patient_id: "pat-009", amount: 3400, amount_outstanding: 2400, paid: false, status: "new" },
  { id: "inv-012a", patient_id: "pat-012", amount: 1200, amount_outstanding: 1200, paid: false, status: "new" },
  { id: "inv-013a", patient_id: "pat-013", amount: 700, amount_outstanding: 450, paid: false, status: "new" },
  { id: "inv-016a", patient_id: "pat-016", amount: 600, amount_outstanding: 600, paid: false, status: "new" },
];

// --- Patient notes (clinical + admin) -------------------------------------
// Mirrors a Dentally patient-notes list. Newest first when read.
export interface MockPatientNote {
  id: string;
  patient_id: string;
  body: string;
  author: string;
  created_at: string; // ISO
}

export const MOCK_PATIENT_NOTES: MockPatientNote[] = [
  { id: "note-002b", patient_id: "pat-002", body: "Implant UR6 fitted, healing well. Review in two weeks.", author: "Dr Priya Adeyemi", created_at: "2026-06-17T14:45:00Z" },
  { id: "note-002a", patient_id: "pat-002", body: "Nervous patient, prefers morning appointments. Discussed sedation options.", author: "Dr Priya Adeyemi", created_at: "2026-05-20T10:10:00Z" },
  { id: "note-001a", patient_id: "pat-001", body: "Keen to start Invisalign. Finance options sent, awaiting decision.", author: "Sarah Okoro", created_at: "2026-06-10T09:00:00Z" },
  { id: "note-011a", patient_id: "pat-011", body: "Allergic to penicillin. Flag before any prescribing.", author: "Dr James Shah", created_at: "2025-07-02T11:40:00Z" },
  { id: "note-010a", patient_id: "pat-010", body: "Moved away in 2024, may have a new local dentist. Worth a courtesy call before chasing.", author: "Reception", created_at: "2026-05-02T11:00:00Z" },
  { id: "note-012a", patient_id: "pat-012", body: "Full mouth rehab accepted but on hold pending finance. Follow up.", author: "Sarah Okoro", created_at: "2026-01-05T10:00:00Z" },
  { id: "note-005a", patient_id: "pat-005", body: "RCT on LL6 complete, crown to follow. Sensitive to cold.", author: "Dr Priya Adeyemi", created_at: "2026-06-08T15:30:00Z" },
];

// Date of birth, so the record can show age.
export const PATIENT_DOB: Record<string, string> = {
  "pat-001": "1958-03-12", "pat-002": "1979-11-02", "pat-003": "1992-08-19",
  "pat-004": "1990-06-21", "pat-005": "1986-01-30", "pat-006": "1971-09-05",
  "pat-007": "1995-12-11", "pat-008": "1983-04-27", "pat-009": "1989-02-14",
  "pat-010": "1949-07-08", "pat-011": "1985-07-15", "pat-012": "1968-10-22",
  "pat-013": "1990-04-04", "pat-014": "1982-09-09", "pat-015": "1975-02-02",
  "pat-016": "1968-11-11", "pat-017": "1995-06-06", "pat-018": "1996-03-15",
};

// Gender, mirroring the real Dentally patient `gender` field (a string here) so the
// demographic pre-filter is demonstrable in dev. Derived from the fixture first names.
export const PATIENT_GENDER: Record<string, "Female" | "Male"> = {
  "pat-001": "Female", "pat-002": "Male", "pat-003": "Female",
  "pat-004": "Male", "pat-005": "Female", "pat-006": "Male",
  "pat-007": "Female", "pat-008": "Male", "pat-009": "Female",
  "pat-010": "Male", "pat-011": "Female", "pat-012": "Male",
  "pat-013": "Female", "pat-014": "Male", "pat-015": "Female",
  "pat-016": "Male", "pat-017": "Female", "pat-018": "Male",
};

// Payment plan per patient, which is what the diary resolves FUNDING from.
//
// The spread is deliberate rather than tidy, because the case most likely to be
// got wrong is the UNRESOLVABLE one and it has to be reachable in dev:
//   9 on plan 1 (NHS), 9 on plan 2 (Private), 2 on 47752 (UDC),
//   2 with the field ABSENT entirely (pat-009, pat-012),
//   1 with payment_plan_id 0 (pat-015), which is "no plan", not plan zero,
//   1 on a real-looking id OUTSIDE this practice's whitelist (pat-018, 90210).
// The last four must all render as no funding mark at all. None of them may ever
// be inferred as private.
export const PATIENT_PAYMENT_PLAN: Record<string, number> = {
  "pat-001": 1, "pat-004": 1, "pat-007": 1, "pat-010": 1, "pat-013": 1,
  "pat-016": 1, "pat-019": 1, "pat-023": 1, "pat-025": 1,
  "pat-002": 2, "pat-005": 2, "pat-008": 2, "pat-011": 2, "pat-014": 2,
  "pat-017": 2, "pat-020": 2, "pat-021": 2, "pat-024": 2,
  "pat-003": 47752, "pat-006": 47752,
  "pat-015": 0,
  "pat-018": 90210,
};

for (const p of MOCK_PATIENTS) {
  const planId = PATIENT_PAYMENT_PLAN[p.id];
  if (planId !== undefined) p.payment_plan_id = planId;
}

/** The patient's payment plan id, or null when there is none on file. */
export function paymentPlanForPatient(patientId: string): number | null {
  const planId = PATIENT_PAYMENT_PLAN[patientId];
  return planId === undefined ? null : planId;
}

// --- Lookups --------------------------------------------------------------

/**
 * Accept a site_id in EITHER form.
 *
 * The app sends the real Dentally site UUID (dentallySiteId), because that is
 * what live expects. The fixtures below are keyed on our internal id
 * ("site-cc"). Before this, every site-scoped read against the mock came back
 * empty in dev while working perfectly against live, which is the worst way
 * round for a mock to fail: nothing errors, the screen simply says the practice
 * did nothing today.
 *
 * Resolving through siteIdFromDentally means a request built for live works
 * against the mock unchanged, and an internal id still works for anything that
 * passes one directly. Unknown values pass through and match nothing.
 */
export function resolveMockSiteId(raw: string | null): string | null {
  if (raw === null || raw.length === 0) return null;
  return siteIdFromDentally(raw) ?? raw;
}

export function findPatient(id: string): MockPatient | undefined {
  return MOCK_PATIENTS.find((p) => p.id === id);
}

export function paymentPlansForPatient(patientId: string): MockPaymentPlan[] {
  return MOCK_PAYMENT_PLANS.filter((pp) => pp.patient_id === patientId);
}

export function treatmentPlansForSite(siteId: string): MockTreatmentPlan[] {
  return MOCK_TREATMENT_PLANS.filter((p) => p.site_id === siteId);
}

/** ONE patient's charting items. The chart read filters by patient again on its
 *  own side, as a safety net against a source that ignores the filter. */
export function treatmentPlanItemsForPatient(patientId: string): MockTreatmentPlanItem[] {
  return MOCK_TREATMENT_PLAN_ITEMS.filter((i) => i.patient_id === patientId);
}
/** One plan's charting items, so the item -> plan -> patient join is exercisable. */
/** One patient's plan-panel cards, oldest card first (by `position`, the card number). */
export function treatmentAppointmentsForPatient(patientId: string): MockTreatmentAppointment[] {
  return MOCK_TREATMENT_APPOINTMENTS.filter((t) => t.patient_id === patientId).sort(
    (a, b) => a.position - b.position,
  );
}

/** One plan's cards. Both filters compose in the route, as they do for items. */
export function treatmentAppointmentsForPlan(planId: string): MockTreatmentAppointment[] {
  return MOCK_TREATMENT_APPOINTMENTS.filter((t) => t.treatment_plan_id === planId);
}

export function treatmentPlanItemsForPlan(planId: string): MockTreatmentPlanItem[] {
  return MOCK_TREATMENT_PLAN_ITEMS.filter((i) => i.treatment_plan_id === planId);
}

export function patientsForSite(siteId: string): MockPatient[] {
  return MOCK_PATIENTS.filter((p) => p.site_id === siteId);
}
/** Persist a newly onboarded patient so they can then be found and booked. */
export function addPatient(p: MockPatient): void {
  MOCK_PATIENTS.push(p);
}
export function appointmentsForPatient(patientId: string): MockAppointment[] {
  return MOCK_APPOINTMENTS.filter((a) => a.patient_id === patientId);
}
export function appointmentsForSite(siteId: string): MockAppointment[] {
  return MOCK_APPOINTMENTS.filter((a) => a.site_id === siteId);
}
export function findAppointmentById(id: string): MockAppointment | undefined {
  return MOCK_APPOINTMENTS.find((a) => a.id === id);
}
/** Persist an API-created appointment so it can later be found, rescheduled or cancelled. */
export function addAppointment(a: MockAppointment): void {
  MOCK_APPOINTMENTS.push(a);
}
/** Mutate an existing appointment in place (reschedule = new start_time; cancel = state). */
export function updateAppointmentFields(id: string, patch: Partial<MockAppointment>): MockAppointment | undefined {
  const a = MOCK_APPOINTMENTS.find((x) => x.id === id);
  if (!a) return undefined;
  Object.assign(a, patch);
  return a;
}
export function invoicesForPatient(patientId: string): MockInvoice[] {
  return MOCK_INVOICES.filter((i) => i.patient_id === patientId);
}
/** Every invoice, for the practice-wide index (the outstanding scan). */
export function allInvoices(): MockInvoice[] {
  return MOCK_INVOICES;
}
export function notesForPatient(patientId: string): MockPatientNote[] {
  return MOCK_PATIENT_NOTES.filter((n) => n.patient_id === patientId).sort((a, b) =>
    a.created_at < b.created_at ? 1 : -1,
  );
}
export function dobForPatient(patientId: string): string | null {
  return PATIENT_DOB[patientId] ?? null;
}
export function genderForPatient(patientId: string): "Female" | "Male" | null {
  return PATIENT_GENDER[patientId] ?? null;
}
