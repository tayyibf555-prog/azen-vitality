// Compliance domain types for the Vitality Dental dashboard.
//
// This is a pure-data layer (no React, no network). It models the fixed UK
// regulatory framework (knowledge.ts) and the practice's current state
// (mock.ts) so the Compliance section has a stable, typed shape to render.
// Structured so the mock state can be swapped for real records later.
//
// DECISION-SUPPORT ONLY. These types and the data behind them organise and
// surface obligations; they are not legal advice and do not replace the
// practice's compliance lead or CQC sign-off (see COMPLIANCE_DISCLAIMER).

/** The five CQC key lines of enquiry (KLOEs) a practice is assessed against. */
export type Kloe = "safe" | "effective" | "caring" | "responsive" | "well_led";

/**
 * Status of any compliance item (audit, policy, training record, KLOE roll-up).
 * - compliant: in date and in place.
 * - due_soon: approaching its due date / review point.
 * - overdue: past its due date and needs completing.
 * - action_needed: in place but flagged for attention (e.g. review due, gap).
 * - not_started: never completed / no record exists yet.
 */
export type ComplianceStatus =
  | "compliant"
  | "due_soon"
  | "overdue"
  | "action_needed"
  | "not_started";

/** A regulated area of practice, mapped to the KLOE it most contributes to. */
export interface ComplianceArea {
  id: string;
  name: string;
  kloe: Kloe;
  regulation: string; // e.g. "HTM 01-05", "IR(ME)R 2017", "GDPR", "CQC Regulation 12"
  description: string;
}

/** The definition of a recurring audit or check (the rule, not an instance). */
export interface AuditDefinition {
  id: string;
  name: string;
  areaId: string;
  regulation: string;
  cadence: string; // human-readable, e.g. "Every 6 months"
  cadenceMonths: number; // numeric cadence for scheduling
  ownerRole: string; // role accountable for completing it
  description: string;
}

/** A scheduled instance of an audit definition, with completion and due dates. */
export interface AuditItem {
  id: string;
  definitionId: string;
  name: string;
  areaId: string;
  kloe: Kloe;
  regulation: string;
  cadence: string;
  lastCompletedAt: string | null; // ISO date, null if never completed
  dueAt: string; // ISO date
  status: ComplianceStatus;
  ownerRole: string;
}

/** The definition of a required (or recommended) practice policy. */
export interface PolicyTemplate {
  id: string;
  name: string;
  category: string;
  kloe: Kloe;
  required: boolean;
  reviewCadence: string; // human-readable, e.g. "Annual"
}

/** A specific policy document held by the practice, with its current status. */
export interface PolicyDoc {
  id: string;
  templateId: string;
  name: string;
  category: string;
  required: boolean;
  status: "in_place" | "review_due" | "missing";
  lastReviewedAt: string | null; // ISO date, null if missing / never reviewed
}

/** A recurring training obligation that applies to one or more roles. */
export interface TrainingRequirement {
  id: string;
  name: string;
  appliesToRoles: string[];
  cadence: string; // human-readable
  cadenceMonths: number; // numeric cadence for scheduling
  mandatory: boolean;
}

/** A member of staff (minimal record for the training matrix). */
export interface StaffMember {
  id: string;
  name: string;
  role: string;
}

/** One staff member's status against one training requirement. */
export interface TrainingRecord {
  id: string;
  staffId: string;
  requirementId: string;
  completedAt: string | null; // ISO date, null if not yet completed
  expiresAt: string | null; // ISO date, null if no expiry / not applicable
  status: ComplianceStatus;
}

/** Roll-up of the practice's position for a single KLOE. */
export interface KloeSummary {
  kloe: Kloe;
  label: string;
  score: number; // 0-100
  status: ComplianceStatus;
  openItems: number; // count of items needing attention mapped to this KLOE
}

/** Top-level readiness picture across all KLOEs and item types. */
export interface ReadinessSummary {
  overallScore: number; // 0-100
  status: ComplianceStatus;
  kloes: KloeSummary[];
  auditsDue: number; // due_soon audits
  auditsOverdue: number; // overdue audits
  policiesNeedingAttention: number; // review_due + missing policies
  trainingExpiring: number; // training records due_soon or overdue
  generatedNote: string; // one neutral sentence summarising the position
}
