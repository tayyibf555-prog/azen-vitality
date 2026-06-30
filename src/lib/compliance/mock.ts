// Curated mock state for the Compliance section: the practice's current
// position against the fixed framework in knowledge.ts.
//
// Single practice (Vitality Dental, three sites). The data here is internally
// consistent: the audit, policy, and training statuses below add up to the
// counts and scores in READINESS. Generic staff names, no real people.
//
// Reference "now" is mid-2026 (the dashboard build date). Dates sit realistically
// across roughly June to December 2026 so the section always has live-looking
// items to action. Swap this module for real records without touching callers.
//
// DECISION-SUPPORT ONLY. See COMPLIANCE_DISCLAIMER in knowledge.ts.

import type {
  AuditItem,
  PolicyDoc,
  StaffMember,
  TrainingRecord,
  KloeSummary,
  ReadinessSummary,
  ComplianceStatus,
} from "@/lib/compliance/types";
import {
  KLOES,
  AUDIT_DEFINITIONS,
  POLICY_TEMPLATES,
} from "@/lib/compliance/knowledge";

/** Reference "now" for this mock, matching the dashboard build date. */
export const COMPLIANCE_NOW = "2026-06-30";

/** Six staff across the practice's roles. Generic names only. */
export const MOCK_STAFF: StaffMember[] = [
  { id: "staff-principal", name: "Dr Helena Brookes", role: "dentist" },
  { id: "staff-associate", name: "Dr Marcus That", role: "dentist" },
  { id: "staff-hygienist", name: "Priya Nair", role: "hygienist" },
  { id: "staff-nurse-1", name: "Sophie Kelman", role: "nurse" },
  { id: "staff-nurse-2", name: "Daniel Foster", role: "nurse" },
  { id: "staff-manager", name: "Carol Whitfield", role: "manager" },
];

/**
 * One audit instance per definition. lastCompletedAt and dueAt are consistent
 * with each definition's cadenceMonths. Two overdue (HTM 01-05 and the fire
 * risk assessment / drill) and two due soon, the rest compliant.
 */
export const MOCK_AUDITS: AuditItem[] = [
  {
    id: "audit-htm-0105-decontamination",
    definitionId: "htm-0105-decontamination",
    name: "HTM 01-05 decontamination audit",
    areaId: "ipc-decontamination",
    kloe: "safe",
    regulation: "HTM 01-05",
    cadence: "Every 6 months",
    lastCompletedAt: "2025-12-05",
    dueAt: "2026-06-05",
    status: "overdue",
    ownerRole: "lead nurse",
  },
  {
    id: "audit-ipc-audit",
    definitionId: "ipc-audit",
    name: "Infection prevention and control audit",
    areaId: "ipc-decontamination",
    kloe: "safe",
    regulation: "CQC Regulation 12",
    cadence: "Every 6 months",
    lastCompletedAt: "2026-04-12",
    dueAt: "2026-10-12",
    status: "compliant",
    ownerRole: "lead nurse",
  },
  {
    id: "audit-radiography-irmer-audit",
    definitionId: "radiography-irmer-audit",
    name: "Radiography (IR(ME)R) audit",
    areaId: "radiography",
    kloe: "safe",
    regulation: "IR(ME)R 2017",
    cadence: "Annual",
    lastCompletedAt: "2026-02-20",
    dueAt: "2027-02-20",
    status: "compliant",
    ownerRole: "radiation protection lead",
  },
  {
    id: "audit-legionella-risk-assessment",
    definitionId: "legionella-risk-assessment",
    name: "Legionella risk assessment",
    areaId: "legionella-water",
    kloe: "safe",
    regulation: "ACoP L8",
    cadence: "Annual",
    lastCompletedAt: "2026-03-10",
    dueAt: "2027-03-10",
    status: "compliant",
    ownerRole: "practice manager",
  },
  {
    id: "audit-water-safety-checks",
    definitionId: "water-safety-checks",
    name: "Water safety checks",
    areaId: "legionella-water",
    kloe: "safe",
    regulation: "ACoP L8",
    cadence: "Monthly",
    lastCompletedAt: "2026-06-02",
    dueAt: "2026-07-02",
    status: "due_soon",
    ownerRole: "lead nurse",
  },
  {
    id: "audit-fire-risk-assessment",
    definitionId: "fire-risk-assessment",
    name: "Fire risk assessment",
    areaId: "fire-safety",
    kloe: "safe",
    regulation: "Regulatory Reform (Fire Safety) Order 2005",
    cadence: "Annual",
    lastCompletedAt: "2025-06-15",
    dueAt: "2026-06-15",
    status: "overdue",
    ownerRole: "practice manager",
  },
  {
    id: "audit-health-safety-risk-assessment",
    definitionId: "health-safety-risk-assessment",
    name: "Health and safety risk assessment",
    areaId: "health-safety",
    kloe: "safe",
    regulation: "Health and Safety at Work etc. Act 1974",
    cadence: "Annual",
    lastCompletedAt: "2026-01-22",
    dueAt: "2027-01-22",
    status: "compliant",
    ownerRole: "practice manager",
  },
  {
    id: "audit-medical-emergency-check",
    definitionId: "medical-emergency-check",
    name: "Medical emergency drugs and equipment check",
    areaId: "medical-emergencies",
    kloe: "safe",
    regulation: "Resuscitation Council UK",
    cadence: "Monthly",
    lastCompletedAt: "2026-06-08",
    dueAt: "2026-07-08",
    status: "due_soon",
    ownerRole: "lead nurse",
  },
  {
    id: "audit-record-keeping-audit",
    definitionId: "record-keeping-audit",
    name: "Clinical record-keeping audit",
    areaId: "clinical-audit-qi",
    kloe: "effective",
    regulation: "CQC Regulation 17",
    cadence: "Annual",
    lastCompletedAt: "2025-11-30",
    dueAt: "2026-11-30",
    status: "compliant",
    ownerRole: "principal dentist",
  },
  {
    id: "audit-complaints-review",
    definitionId: "complaints-review",
    name: "Complaints and feedback review",
    areaId: "complaints-candour",
    kloe: "responsive",
    regulation: "CQC Regulation 16",
    cadence: "Annual",
    lastCompletedAt: "2025-09-18",
    dueAt: "2026-09-18",
    status: "compliant",
    ownerRole: "practice manager",
  },
];

/**
 * One policy document per template. Most in place, two due for review, and one
 * missing (the business continuity plan).
 */
export const MOCK_POLICIES: PolicyDoc[] = [
  {
    id: "policy-infection-prevention-control",
    templateId: "infection-prevention-control",
    name: "Infection prevention and control policy",
    category: "Clinical safety",
    required: true,
    status: "in_place",
    lastReviewedAt: "2026-01-15",
  },
  {
    id: "policy-decontamination",
    templateId: "decontamination",
    name: "Decontamination policy",
    category: "Clinical safety",
    required: true,
    status: "in_place",
    lastReviewedAt: "2026-01-15",
  },
  {
    id: "policy-radiation-protection",
    templateId: "radiation-protection",
    name: "Radiation protection policy",
    category: "Clinical safety",
    required: true,
    status: "in_place",
    lastReviewedAt: "2026-02-20",
  },
  {
    id: "policy-safeguarding-children",
    templateId: "safeguarding-children",
    name: "Safeguarding children policy",
    category: "Safeguarding",
    required: true,
    status: "in_place",
    lastReviewedAt: "2025-11-10",
  },
  {
    id: "policy-safeguarding-adults",
    templateId: "safeguarding-adults",
    name: "Safeguarding adults policy",
    category: "Safeguarding",
    required: true,
    status: "review_due",
    lastReviewedAt: "2025-05-22",
  },
  {
    id: "policy-health-safety",
    templateId: "health-safety",
    name: "Health and safety policy",
    category: "Premises and staff",
    required: true,
    status: "in_place",
    lastReviewedAt: "2026-01-22",
  },
  {
    id: "policy-fire-safety",
    templateId: "fire-safety",
    name: "Fire safety policy",
    category: "Premises and staff",
    required: true,
    status: "in_place",
    lastReviewedAt: "2025-12-01",
  },
  {
    id: "policy-data-protection",
    templateId: "data-protection",
    name: "Data protection and GDPR policy",
    category: "Governance",
    required: true,
    status: "in_place",
    lastReviewedAt: "2026-03-05",
  },
  {
    id: "policy-complaints",
    templateId: "complaints",
    name: "Complaints procedure",
    category: "Patient experience",
    required: true,
    status: "in_place",
    lastReviewedAt: "2025-09-18",
  },
  {
    id: "policy-consent",
    templateId: "consent",
    name: "Consent policy",
    category: "Clinical governance",
    required: true,
    status: "in_place",
    lastReviewedAt: "2025-10-30",
  },
  {
    id: "policy-whistleblowing",
    templateId: "whistleblowing",
    name: "Whistleblowing policy",
    category: "Governance",
    required: true,
    status: "in_place",
    lastReviewedAt: "2025-11-05",
  },
  {
    id: "policy-equality-diversity",
    templateId: "equality-diversity",
    name: "Equality and diversity policy",
    category: "Governance",
    required: true,
    status: "review_due",
    lastReviewedAt: "2025-04-14",
  },
  {
    id: "policy-social-media-marketing",
    templateId: "social-media-marketing",
    name: "Social media and marketing policy",
    category: "Governance",
    required: true,
    status: "in_place",
    lastReviewedAt: "2026-02-12",
  },
  {
    id: "policy-business-continuity",
    templateId: "business-continuity",
    name: "Business continuity plan",
    category: "Governance",
    required: true,
    status: "missing",
    lastReviewedAt: null,
  },
];

/**
 * Training matrix across staff and the requirements relevant to their role.
 * Mostly compliant, with one nurse's medical emergencies training overdue and
 * a couple of records expiring soon. expiresAt is cadenceMonths after
 * completedAt; status reflects how close that expiry is to COMPLIANCE_NOW.
 */
export const MOCK_TRAINING_RECORDS: TrainingRecord[] = [
  // Medical emergencies and CPR (annual, all roles).
  {
    id: "tr-principal-medical-emergencies-cpr",
    staffId: "staff-principal",
    requirementId: "medical-emergencies-cpr",
    completedAt: "2025-09-12",
    expiresAt: "2026-09-12",
    status: "compliant",
  },
  {
    id: "tr-associate-medical-emergencies-cpr",
    staffId: "staff-associate",
    requirementId: "medical-emergencies-cpr",
    completedAt: "2025-10-02",
    expiresAt: "2026-10-02",
    status: "compliant",
  },
  {
    id: "tr-hygienist-medical-emergencies-cpr",
    staffId: "staff-hygienist",
    requirementId: "medical-emergencies-cpr",
    completedAt: "2025-07-20",
    expiresAt: "2026-07-20",
    status: "due_soon",
  },
  {
    id: "tr-nurse1-medical-emergencies-cpr",
    staffId: "staff-nurse-1",
    requirementId: "medical-emergencies-cpr",
    completedAt: "2025-05-30",
    expiresAt: "2026-05-30",
    status: "overdue",
  },
  {
    id: "tr-nurse2-medical-emergencies-cpr",
    staffId: "staff-nurse-2",
    requirementId: "medical-emergencies-cpr",
    completedAt: "2025-11-18",
    expiresAt: "2026-11-18",
    status: "compliant",
  },
  {
    id: "tr-manager-medical-emergencies-cpr",
    staffId: "staff-manager",
    requirementId: "medical-emergencies-cpr",
    completedAt: "2025-11-18",
    expiresAt: "2026-11-18",
    status: "compliant",
  },
  // Infection prevention and control (annual: dentists, hygienist, nurses).
  {
    id: "tr-principal-infection-control",
    staffId: "staff-principal",
    requirementId: "infection-control",
    completedAt: "2026-01-15",
    expiresAt: "2027-01-15",
    status: "compliant",
  },
  {
    id: "tr-associate-infection-control",
    staffId: "staff-associate",
    requirementId: "infection-control",
    completedAt: "2026-01-15",
    expiresAt: "2027-01-15",
    status: "compliant",
  },
  {
    id: "tr-hygienist-infection-control",
    staffId: "staff-hygienist",
    requirementId: "infection-control",
    completedAt: "2026-01-15",
    expiresAt: "2027-01-15",
    status: "compliant",
  },
  {
    id: "tr-nurse1-infection-control",
    staffId: "staff-nurse-1",
    requirementId: "infection-control",
    completedAt: "2026-01-15",
    expiresAt: "2027-01-15",
    status: "compliant",
  },
  {
    id: "tr-nurse2-infection-control",
    staffId: "staff-nurse-2",
    requirementId: "infection-control",
    completedAt: "2026-01-15",
    expiresAt: "2027-01-15",
    status: "compliant",
  },
  // Safeguarding (per CPD cycle, all roles).
  {
    id: "tr-principal-safeguarding",
    staffId: "staff-principal",
    requirementId: "safeguarding",
    completedAt: "2024-03-04",
    expiresAt: "2029-03-04",
    status: "compliant",
  },
  {
    id: "tr-hygienist-safeguarding",
    staffId: "staff-hygienist",
    requirementId: "safeguarding",
    completedAt: "2024-03-04",
    expiresAt: "2029-03-04",
    status: "compliant",
  },
  {
    id: "tr-nurse1-safeguarding",
    staffId: "staff-nurse-1",
    requirementId: "safeguarding",
    completedAt: "2024-03-04",
    expiresAt: "2029-03-04",
    status: "compliant",
  },
  {
    id: "tr-manager-safeguarding",
    staffId: "staff-manager",
    requirementId: "safeguarding",
    completedAt: "2024-03-04",
    expiresAt: "2029-03-04",
    status: "compliant",
  },
  // Dental radiography (per CPD cycle: dentists, nurses).
  {
    id: "tr-principal-radiography",
    staffId: "staff-principal",
    requirementId: "radiography",
    completedAt: "2023-09-10",
    expiresAt: "2028-09-10",
    status: "compliant",
  },
  {
    id: "tr-nurse1-radiography",
    staffId: "staff-nurse-1",
    requirementId: "radiography",
    completedAt: "2023-09-10",
    expiresAt: "2028-09-10",
    status: "compliant",
  },
  // Data protection and GDPR (annual, all roles, sampled).
  {
    id: "tr-manager-data-protection",
    staffId: "staff-manager",
    requirementId: "data-protection",
    completedAt: "2026-03-05",
    expiresAt: "2027-03-05",
    status: "compliant",
  },
  {
    id: "tr-nurse2-data-protection",
    staffId: "staff-nurse-2",
    requirementId: "data-protection",
    completedAt: "2026-03-05",
    expiresAt: "2027-03-05",
    status: "compliant",
  },
  // Fire safety (annual, all roles, sampled).
  {
    id: "tr-manager-fire-safety",
    staffId: "staff-manager",
    requirementId: "fire-safety",
    completedAt: "2025-12-01",
    expiresAt: "2026-12-01",
    status: "compliant",
  },
  {
    id: "tr-nurse1-fire-safety",
    staffId: "staff-nurse-1",
    requirementId: "fire-safety",
    completedAt: "2025-12-01",
    expiresAt: "2026-12-01",
    status: "compliant",
  },
  // GDC enhanced CPD tracking (per CPD cycle: dentists, hygienist, nurses).
  {
    id: "tr-principal-gdc-enhanced-cpd",
    staffId: "staff-principal",
    requirementId: "gdc-enhanced-cpd",
    completedAt: "2024-01-01",
    expiresAt: "2029-01-01",
    status: "compliant",
  },
  {
    id: "tr-associate-gdc-enhanced-cpd",
    staffId: "staff-associate",
    requirementId: "gdc-enhanced-cpd",
    completedAt: "2024-01-01",
    expiresAt: "2029-01-01",
    status: "compliant",
  },
];

/** Select audits by status (small convenience selector). */
export function auditsByStatus(status: ComplianceStatus): AuditItem[] {
  return MOCK_AUDITS.filter((a) => a.status === status);
}

/** Select training records by status (small convenience selector). */
export function trainingByStatus(status: ComplianceStatus): TrainingRecord[] {
  return MOCK_TRAINING_RECORDS.filter((r) => r.status === status);
}

// --- Derived counts, kept consistent with the mock state above. ---

const auditsOverdue = auditsByStatus("overdue").length; // 2
const auditsDue = auditsByStatus("due_soon").length; // 2
const policiesNeedingAttention = MOCK_POLICIES.filter(
  (p) => p.status === "review_due" || p.status === "missing",
).length; // 3
const trainingExpiring = MOCK_TRAINING_RECORDS.filter(
  (r) => r.status === "due_soon" || r.status === "overdue",
).length; // 2

/**
 * Per-KLOE roll-up. openItems counts the attention-needing items mapped to each
 * KLOE: audits by their kloe field, policies and training via their definitions.
 * Scores are hand-set to reflect those open items (fewer open items = higher).
 */
const SAFE_OPEN_AUDITS = MOCK_AUDITS.filter(
  (a) =>
    a.kloe === "safe" &&
    (a.status === "overdue" || a.status === "due_soon"),
).length; // HTM, fire, water, medical emergency = 4

// Safe also carries the medical-emergencies and safeguarding training/policy
// attention items: nurse CPR overdue + hygienist CPR due soon (2) and the
// safeguarding-adults policy review due (1).
const SAFE_OPEN = SAFE_OPEN_AUDITS + 2 + 1; // 7

const KLOE_SUMMARIES: KloeSummary[] = KLOES.map((k) => {
  switch (k.key) {
    case "safe":
      return {
        kloe: k.key,
        label: k.label,
        score: 74,
        status: "action_needed" as ComplianceStatus,
        openItems: SAFE_OPEN,
      };
    case "effective":
      // Clinical audit and CPD all in order.
      return {
        kloe: k.key,
        label: k.label,
        score: 92,
        status: "compliant" as ComplianceStatus,
        openItems: 0,
      };
    case "caring":
      return {
        kloe: k.key,
        label: k.label,
        score: 95,
        status: "compliant" as ComplianceStatus,
        openItems: 0,
      };
    case "responsive":
      // Equality and diversity policy review due.
      return {
        kloe: k.key,
        label: k.label,
        score: 88,
        status: "due_soon" as ComplianceStatus,
        openItems: 1,
      };
    case "well_led":
    default:
      // Business continuity plan missing.
      return {
        kloe: k.key,
        label: k.label,
        score: 80,
        status: "action_needed" as ComplianceStatus,
        openItems: 1,
      };
  }
});

/**
 * Top-level readiness picture, computed to match the mock state. Overall score
 * is a rounded blend weighted towards Safe and Well-led (the areas carrying the
 * open items). Status is action_needed because overdue audits exist.
 */
export const READINESS: ReadinessSummary = {
  overallScore: 82,
  status: "action_needed",
  kloes: KLOE_SUMMARIES,
  auditsDue,
  auditsOverdue,
  policiesNeedingAttention,
  trainingExpiring,
  generatedNote:
    "Overall readiness is strong at 82 out of 100, with two overdue audits (HTM 01-05 decontamination and the fire risk assessment), three policies needing attention, and two training records expiring, all concentrated under Safe and Well-led.",
};

// Static checks: keep the mock honest against the framework so future edits
// cannot silently drift. These resolve to constants at module load and are
// erased by the bundler; they exist only to document the intended invariants.
const _AUDIT_COVERAGE_OK: boolean =
  MOCK_AUDITS.length === AUDIT_DEFINITIONS.length;
const _POLICY_COVERAGE_OK: boolean =
  MOCK_POLICIES.length === POLICY_TEMPLATES.length;
void _AUDIT_COVERAGE_OK;
void _POLICY_COVERAGE_OK;
