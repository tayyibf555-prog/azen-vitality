// Fixed UK dental regulatory framework for the Compliance section.
//
// This file is the curated, slow-moving "knowledge": the five CQC KLOEs, the
// regulated compliance areas, the recurring audits and their cadences, the
// required practice policies, and the recurring training obligations. It holds
// no practice-specific state (that lives in mock.ts).
//
// Grounded in the current UK framework: CQC registration assessed against the
// five KLOEs; HTM 01-05 decontamination and IPC audits; dental radiography
// under IRR17 and IR(ME)R 2017; Legionella and water safety; fire safety;
// health and safety; safeguarding; medical emergencies; GDC registration,
// indemnity and enhanced CPD; DBS and recruitment; data protection (GDPR);
// complaints and duty of candour; and clinical audit / quality improvement.
//
// DECISION-SUPPORT ONLY. See COMPLIANCE_DISCLAIMER at the foot of this file.

import type {
  Kloe,
  ComplianceArea,
  AuditDefinition,
  PolicyTemplate,
  TrainingRequirement,
} from "@/lib/compliance/types";

/**
 * The five CQC key lines of enquiry, with the headline CQC question phrasing
 * and a short description of what each covers for a dental practice.
 */
export const KLOES: {
  key: Kloe;
  label: string;
  question: string;
  description: string;
}[] = [
  {
    key: "safe",
    label: "Safe",
    question: "Are people protected from abuse and avoidable harm?",
    description:
      "Infection prevention and control, decontamination, radiation safety, medical emergencies, safeguarding, and premises safety (fire, Legionella, health and safety).",
  },
  {
    key: "effective",
    label: "Effective",
    question:
      "Does people's care, treatment and support achieve good outcomes and promote a good quality of life, based on the best available evidence?",
    description:
      "Evidence-based care, consent, clinical record keeping, staff competence and training, and clinical audit feeding quality improvement.",
  },
  {
    key: "caring",
    label: "Caring",
    question:
      "Do staff involve and treat people with compassion, kindness, dignity and respect?",
    description:
      "Dignity, privacy, communication, and involving patients in decisions about their care.",
  },
  {
    key: "responsive",
    label: "Responsive",
    question: "Does the service meet people's needs?",
    description:
      "Accessible services, reasonable adjustments, and a clear complaints procedure with learning from feedback.",
  },
  {
    key: "well_led",
    label: "Well-led",
    question:
      "Does the leadership, management and governance of the organisation assure the delivery of high-quality care?",
    description:
      "Governance, policies, staff recruitment and registration (GDC, DBS, indemnity), data protection, duty of candour, and a culture of continuous improvement.",
  },
];

/**
 * The regulated compliance areas, each mapped to the KLOE it most contributes
 * to. Stable kebab-case ids; regulation is the headline standard or rule.
 */
export const COMPLIANCE_AREAS: ComplianceArea[] = [
  {
    id: "ipc-decontamination",
    name: "Infection prevention and control (decontamination)",
    kloe: "safe",
    regulation: "HTM 01-05",
    description:
      "IPC policy, decontamination of reusable instruments, and recurring IPC and HTM 01-05 audits.",
  },
  {
    id: "radiography",
    name: "Dental radiography (radiation safety)",
    kloe: "safe",
    regulation: "IR(ME)R 2017",
    description:
      "Radiation protection, equipment quality assurance, and radiography audits under IRR17 and IR(ME)R 2017.",
  },
  {
    id: "legionella-water",
    name: "Legionella and water safety",
    kloe: "safe",
    regulation: "ACoP L8",
    description:
      "Legionella risk assessment and ongoing water safety checks for dental unit waterlines and the wider water system.",
  },
  {
    id: "fire-safety",
    name: "Fire safety",
    kloe: "safe",
    regulation: "Regulatory Reform (Fire Safety) Order 2005",
    description:
      "Fire risk assessment, evacuation procedures, equipment checks, and regular fire drills.",
  },
  {
    id: "health-safety",
    name: "Health and safety",
    kloe: "safe",
    regulation: "Health and Safety at Work etc. Act 1974",
    description:
      "Premises and equipment risk assessments, COSHH, and safe working practices.",
  },
  {
    id: "safeguarding",
    name: "Safeguarding (children and adults)",
    kloe: "safe",
    regulation: "CQC Regulation 13",
    description:
      "Safeguarding policies for children and vulnerable adults, with trained staff and clear referral routes.",
  },
  {
    id: "medical-emergencies",
    name: "Medical emergencies",
    kloe: "safe",
    regulation: "Resuscitation Council UK",
    description:
      "In-date emergency drugs and equipment, with all clinical staff trained in CPR and medical emergencies.",
  },
  {
    id: "gdc-registration-indemnity",
    name: "GDC registration and indemnity",
    kloe: "well_led",
    regulation: "Dentists Act 1984",
    description:
      "Current GDC registration and adequate indemnity cover for all registered clinicians.",
  },
  {
    id: "dbs-recruitment",
    name: "DBS and safe recruitment",
    kloe: "well_led",
    regulation: "CQC Regulation 19",
    description:
      "DBS checks, references, and safe recruitment processes for all staff.",
  },
  {
    id: "cpd-training",
    name: "CPD and mandatory training",
    kloe: "effective",
    regulation: "GDC enhanced CPD",
    description:
      "GDC enhanced CPD tracking and completion of mandatory training across the team.",
  },
  {
    id: "data-protection",
    name: "Data protection (GDPR)",
    kloe: "well_led",
    regulation: "GDPR",
    description:
      "Lawful handling of patient data, information governance, and breach procedures under UK GDPR and the Data Protection Act 2018.",
  },
  {
    id: "complaints-candour",
    name: "Complaints and duty of candour",
    kloe: "responsive",
    regulation: "CQC Regulation 16 and 20",
    description:
      "An accessible complaints procedure, learning from feedback, and meeting the duty of candour.",
  },
  {
    id: "clinical-audit-qi",
    name: "Clinical audit and quality improvement",
    kloe: "effective",
    regulation: "CQC Regulation 17",
    description:
      "Recurring clinical audits (record keeping, radiography), feedback, and significant event analysis driving improvement.",
  },
];

/**
 * The recurring audits and checks the practice runs, with realistic cadences.
 * cadenceMonths is the numeric interval used for scheduling the next due date.
 */
export const AUDIT_DEFINITIONS: AuditDefinition[] = [
  {
    id: "htm-0105-decontamination",
    name: "HTM 01-05 decontamination audit",
    areaId: "ipc-decontamination",
    regulation: "HTM 01-05",
    cadence: "Every 6 months",
    cadenceMonths: 6,
    ownerRole: "lead nurse",
    description:
      "Six-monthly decontamination audit of the instrument reprocessing cycle against HTM 01-05.",
  },
  {
    id: "ipc-audit",
    name: "Infection prevention and control audit",
    areaId: "ipc-decontamination",
    regulation: "CQC Regulation 12",
    cadence: "Every 6 months",
    cadenceMonths: 6,
    ownerRole: "lead nurse",
    description:
      "Six-monthly IPC audit covering hand hygiene, PPE, surface decontamination, and waste handling.",
  },
  {
    id: "radiography-irmer-audit",
    name: "Radiography (IR(ME)R) audit",
    areaId: "radiography",
    regulation: "IR(ME)R 2017",
    cadence: "Annual",
    cadenceMonths: 12,
    ownerRole: "radiation protection lead",
    description:
      "Annual audit of radiographic image quality, justification, and exposure records under IRR17 and IR(ME)R 2017.",
  },
  {
    id: "legionella-risk-assessment",
    name: "Legionella risk assessment",
    areaId: "legionella-water",
    regulation: "ACoP L8",
    cadence: "Annual",
    cadenceMonths: 12,
    ownerRole: "practice manager",
    description:
      "Annual Legionella risk assessment of the water system, underpinned by the monthly water checks.",
  },
  {
    id: "water-safety-checks",
    name: "Water safety checks",
    areaId: "legionella-water",
    regulation: "ACoP L8",
    cadence: "Monthly",
    cadenceMonths: 1,
    ownerRole: "lead nurse",
    description:
      "Monthly temperature and dental unit waterline checks supporting the annual Legionella assessment.",
  },
  {
    id: "fire-risk-assessment",
    name: "Fire risk assessment",
    areaId: "fire-safety",
    regulation: "Regulatory Reform (Fire Safety) Order 2005",
    cadence: "Annual",
    cadenceMonths: 12,
    ownerRole: "practice manager",
    description:
      "Annual review of the fire risk assessment, with evacuation procedures and fire drills logged.",
  },
  {
    id: "health-safety-risk-assessment",
    name: "Health and safety risk assessment",
    areaId: "health-safety",
    regulation: "Health and Safety at Work etc. Act 1974",
    cadence: "Annual",
    cadenceMonths: 12,
    ownerRole: "practice manager",
    description:
      "Annual premises and equipment risk assessment, including COSHH and electrical safety.",
  },
  {
    id: "medical-emergency-check",
    name: "Medical emergency drugs and equipment check",
    areaId: "medical-emergencies",
    regulation: "Resuscitation Council UK",
    cadence: "Monthly",
    cadenceMonths: 1,
    ownerRole: "lead nurse",
    description:
      "Monthly check that emergency drugs and equipment are present, complete, and in date.",
  },
  {
    id: "record-keeping-audit",
    name: "Clinical record-keeping audit",
    areaId: "clinical-audit-qi",
    regulation: "CQC Regulation 17",
    cadence: "Annual",
    cadenceMonths: 12,
    ownerRole: "principal dentist",
    description:
      "Annual audit of a sample of clinical records for completeness, consent, and accuracy.",
  },
  {
    id: "complaints-review",
    name: "Complaints and feedback review",
    areaId: "complaints-candour",
    regulation: "CQC Regulation 16",
    cadence: "Annual",
    cadenceMonths: 12,
    ownerRole: "practice manager",
    description:
      "Annual review of complaints and feedback to confirm timely handling and learning, alongside ongoing significant event reviews.",
  },
];

/**
 * The required (and recommended) UK dental practice policies. reviewCadence is
 * typically annual. required marks those a CQC-registered practice must hold.
 */
export const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: "infection-prevention-control",
    name: "Infection prevention and control policy",
    category: "Clinical safety",
    kloe: "safe",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "decontamination",
    name: "Decontamination policy",
    category: "Clinical safety",
    kloe: "safe",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "radiation-protection",
    name: "Radiation protection policy",
    category: "Clinical safety",
    kloe: "safe",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "safeguarding-children",
    name: "Safeguarding children policy",
    category: "Safeguarding",
    kloe: "safe",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "safeguarding-adults",
    name: "Safeguarding adults policy",
    category: "Safeguarding",
    kloe: "safe",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "health-safety",
    name: "Health and safety policy",
    category: "Premises and staff",
    kloe: "safe",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "fire-safety",
    name: "Fire safety policy",
    category: "Premises and staff",
    kloe: "safe",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "data-protection",
    name: "Data protection and GDPR policy",
    category: "Governance",
    kloe: "well_led",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "complaints",
    name: "Complaints procedure",
    category: "Patient experience",
    kloe: "responsive",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "consent",
    name: "Consent policy",
    category: "Clinical governance",
    kloe: "effective",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "whistleblowing",
    name: "Whistleblowing policy",
    category: "Governance",
    kloe: "well_led",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "equality-diversity",
    name: "Equality and diversity policy",
    category: "Governance",
    kloe: "responsive",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "social-media-marketing",
    name: "Social media and marketing policy",
    category: "Governance",
    kloe: "well_led",
    required: true,
    reviewCadence: "Annual",
  },
  {
    id: "business-continuity",
    name: "Business continuity plan",
    category: "Governance",
    kloe: "well_led",
    required: true,
    reviewCadence: "Annual",
  },
];

/**
 * The recurring training obligations. "Per cycle" maps to the GDC five-year CPD
 * cycle (60 months) where a topic is required at least once per cycle rather
 * than annually. appliesToRoles is drawn from the practice's role set.
 */
export const TRAINING_REQUIREMENTS: TrainingRequirement[] = [
  {
    id: "medical-emergencies-cpr",
    name: "Medical emergencies and CPR",
    appliesToRoles: ["dentist", "hygienist", "nurse", "reception", "manager"],
    cadence: "Annual",
    cadenceMonths: 12,
    mandatory: true,
  },
  {
    id: "infection-control",
    name: "Infection prevention and control",
    appliesToRoles: ["dentist", "hygienist", "nurse"],
    cadence: "Annual",
    cadenceMonths: 12,
    mandatory: true,
  },
  {
    id: "safeguarding",
    name: "Safeguarding (children and adults)",
    appliesToRoles: ["dentist", "hygienist", "nurse", "reception", "manager"],
    cadence: "Per CPD cycle",
    cadenceMonths: 60,
    mandatory: true,
  },
  {
    id: "radiography",
    name: "Dental radiography",
    appliesToRoles: ["dentist", "nurse"],
    cadence: "Per CPD cycle",
    cadenceMonths: 60,
    mandatory: true,
  },
  {
    id: "data-protection",
    name: "Data protection and GDPR",
    appliesToRoles: ["dentist", "hygienist", "nurse", "reception", "manager"],
    cadence: "Annual",
    cadenceMonths: 12,
    mandatory: true,
  },
  {
    id: "fire-safety",
    name: "Fire safety",
    appliesToRoles: ["dentist", "hygienist", "nurse", "reception", "manager"],
    cadence: "Annual",
    cadenceMonths: 12,
    mandatory: true,
  },
  {
    id: "complaints-handling",
    name: "Complaints handling",
    appliesToRoles: ["reception", "manager"],
    cadence: "Per CPD cycle",
    cadenceMonths: 60,
    mandatory: true,
  },
  {
    id: "disability-equality",
    name: "Disability and equality awareness",
    appliesToRoles: ["dentist", "hygienist", "nurse", "reception", "manager"],
    cadence: "Per CPD cycle",
    cadenceMonths: 60,
    mandatory: true,
  },
  {
    id: "gdc-enhanced-cpd",
    name: "GDC enhanced CPD tracking",
    appliesToRoles: ["dentist", "hygienist", "nurse"],
    cadence: "Per CPD cycle",
    cadenceMonths: 60,
    mandatory: true,
  },
];

/**
 * Short disclaimer surfaced wherever the Compliance section is shown.
 * British English, no dashes.
 */
export const COMPLIANCE_DISCLAIMER: string =
  "This Compliance section is a decision-support tool and an organiser for the practice's regulatory obligations. It is not legal advice and does not replace the judgement of the practice's compliance lead, a specialist compliance consultant, or formal CQC sign-off. Always confirm specific requirements with a suitably qualified person before acting.";
