/**
 * Shared domain types for the Azen x Vitality platform.
 *
 * Design rules baked in here:
 *  - Multi-site by default: every operational entity carries `siteId`. Never assume one site.
 *  - Built on Dentally: ids and fields mirror Dentally concepts where relevant
 *    (recall dates, appointment state machine, acquisition source, planned treatment value).
 *  - No clinical data ever lives in these types. Operations layer only.
 *
 * In this first build these types describe MOCK data. When real auth + Dentally land,
 * the same shapes are populated from Supabase / the Dentally API.
 */

/* ----------------------------------------------------------------------------
 * Tenancy: Agency -> Client -> Site
 * -------------------------------------------------------------------------- */

export type Role = "agency_admin" | "client_owner" | "client_coordinator";

export interface Client {
  id: string;
  slug: string; // used in /c/[slug]
  name: string; // e.g. "Vitality Dental Network"
  status: "live" | "onboarding" | "paused";
  /** Dentally connection health, mocked for now. */
  dentally: {
    connected: boolean;
    /** ISO timestamp of last successful poll (Dentally has no webhooks, we poll). */
    lastSyncedAt: string | null;
  };
  siteIds: string[];
}

export type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/** Opening window per weekday: "HH:MM-HH:MM" (local time) or null = closed. */
export type OpeningHours = Record<Weekday, string | null>;

export interface Site {
  id: string; // stable INTERNAL id (overlay tables, UI, tests key on this)
  clientId: string;
  name: string; // display label
  /**
   * The REAL Dentally site_id (a UUID) this internal site maps to. Dentally reads
   * use this; responses are mapped back to `id`. Absent in the mock/pilot, where
   * the internal id is used directly.
   */
  dentallyId?: string;
  timezone: string;
  /** Local opening windows, used by the after-hours capture module. */
  openingHours?: OpeningHours;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** null for agency_admin (spans all clients); set for client users. */
  clientId: string | null;
}

/* ----------------------------------------------------------------------------
 * Operational entities (all site-scoped)
 * -------------------------------------------------------------------------- */

// "contacting" is a transient in-flight claim: the speed-to-lead SLA sweep moves a
// lead 'new' → 'contacting' atomically before sending, so it can't race the
// in-request intake contact. It resets to 'new' on send failure and advances to
// 'contacted' on success, so it is short-lived; the worklist treats it like 'new'.
// "nurture_done" is terminal: a contacted-but-quiet lead has had its full 3-touch
// nurture with no reply, so it is retired from the warm-up cadence.
export type LeadStage =
  | "new"
  | "contacting"
  | "contacted"
  | "qualifying"
  | "booked"
  | "lost"
  | "nurture_done";
export type Channel = "sms" | "email" | "whatsapp" | "phone";

export interface Lead {
  id: string;
  siteId: string;
  name: string;
  stage: LeadStage;
  /** Smile Assessment score 0-100 (intent + fit only, never clinical suitability). */
  assessmentScore: number | null;
  treatmentInterest: string; // e.g. "Invisalign", "Implants", "Hygiene"
  source: string; // acquisition_source in Dentally terms
  createdAt: string; // ISO
  /** Seconds from enquiry to first contact (speed-to-lead instrumentation). */
  firstResponseSeconds: number | null;
  channel: Channel;
}

/** Dentally appointment state machine. */
export type AppointmentState =
  | "pending"
  | "confirmed"
  | "arrived"
  | "in_surgery"
  | "completed"
  | "cancelled"
  | "did_not_attend";

export interface Appointment {
  id: string;
  siteId: string;
  patientName: string;
  practitioner: string;
  treatment: string;
  state: AppointmentState;
  start: string; // ISO
  value: number; // GBP
  bookedViaApi: boolean; // Dentally booked_via_api flag (attributes bookings to us)
}

export type RecallType = "dentist" | "hygienist";

export interface RecallItem {
  id: string;
  siteId: string;
  patientName: string;
  type: RecallType;
  dueDate: string; // ISO, from Dentally recall_date
  consent: { sms: boolean; email: boolean }; // respect before any outbound
  status: "due" | "contacted" | "booked" | "no_response";
  lastContactedAt: string | null;
}

export interface TreatmentPlan {
  id: string;
  siteId: string;
  patientName: string;
  treatment: string;
  plannedValue: number; // Dentally planned_private_treatment_value
  acceptedAt: string; // ISO
  /** Completed-but-incomplete is the core leak. */
  status: "accepted" | "in_progress" | "stalled" | "completed";
  financePresented: boolean;
  lastTouchAt: string | null;
}

export interface BriefItem {
  id: string;
  siteId: string;
  role: Role | "all";
  priority: "high" | "medium" | "low";
  title: string;
  detail: string;
  /** What this ties back to: bookings, recovered revenue, or time saved. */
  metric: "bookings" | "revenue" | "time" | "risk";
}

/* ----------------------------------------------------------------------------
 * Dashboard metrics
 * -------------------------------------------------------------------------- */

export interface MetricPoint {
  label: string; // e.g. day or week label
  value: number;
}

export interface SiteMetrics {
  siteId: string;
  leadsIn: number;
  consultationsBooked: number;
  costPerBooking: number;
  recoveredRevenue: number;
  recallRecoveryRate: number; // 0-1
  treatmentRecoveryRate: number; // 0-1
  noShowRate: number; // 0-1
  hoursSaved: number;
}

export interface ClientMetrics {
  clientId: string;
  leadsIn: number;
  consultationsBooked: number;
  recoveredRevenue: number;
  hoursSaved: number;
  trend: MetricPoint[]; // recovered revenue over time, for sparkline
}
