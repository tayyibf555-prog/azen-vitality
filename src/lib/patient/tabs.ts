/**
 * The patient record's eleven tabs: slugs, order, labels, and the exact words each
 * unfillable tab says about itself.
 *
 * PURE. No I/O. Tested.
 *
 * WHY THE COPY LIVES HERE rather than in the JSX that renders it. These are
 * clinical-safety sentences. On a patient record, "this patient has none" and "we
 * cannot read this" are DIFFERENT CLINICAL FACTS, and conflating them is a
 * patient-safety event, not a copy nit. Kept in a tested module they can be reviewed
 * in one place and a test can hold the line; buried in a component they drift.
 *
 * THE FOUR SENTENCES, and they are never interchangeable:
 *   A. "This patient has none."  A real read returned nothing.
 *   B. "We cannot read this."    Dentally exposes no endpoint we call.
 *   C. "We do not hold this yet." Our own side, not built or not wired.
 *   D. "The read failed."        A read we DO have threw just now.
 *
 * ORDER AND COMPLETENESS. All eleven are always rendered, in Dentally's own order,
 * with NO marker on the tab itself. Hiding a tab reads as a lost capability to a
 * Dentally user who goes looking for it; marking four of eleven is the row-of-amber-
 * chips failure PRODUCT.md names, where the caveats shout louder than the facts. The
 * honesty belongs inside the panel, attached to the thing it concerns, quietly.
 */

export const PATIENT_TAB_SLUGS = [
  "details",
  "medical",
  "chart",
  "appointments",
  "recalls",
  "notes",
  "account",
  "perio",
  "correspondence",
  "tasks",
  "audit",
] as const;

export type PatientTabSlug = (typeof PATIENT_TAB_SLUGS)[number];

/**
 * How much of this tab we can actually fill.
 *   live         - a real read backs it end to end.
 *   partial      - a real read backs it, but Dentally's own screen holds more.
 *   unreadable   - Dentally exposes nothing we can call. Category B.
 *   not-held-yet - our own side, not built. Category C.
 */
export type TabAvailability = "live" | "partial" | "unreadable" | "not-held-yet";

export interface PatientTab {
  slug: PatientTabSlug;
  label: string;
  availability: TabAvailability;
  /**
   * For an `unreadable` tab, the sentence that must be read before this patient is
   * treated. Empty for tabs that render real content and carry their caveats inline.
   */
  cannotRead: string;
  /** What the tab WILL hold, so an empty screen still says what it is for. */
  willHold: string;
}

export const PATIENT_TABS: readonly PatientTab[] = [
  {
    slug: "details",
    label: "Details",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "medical",
    label: "Medical",
    availability: "unreadable",
    // The hardest case in the whole record, and the one the honesty rule exists for.
    // There is no medical read of any kind here: no client method, no endpoint, no
    // table, no column. "No medical history recorded" would be a fabrication that a
    // clinician could act on.
    cannotRead:
      "We cannot read medical history. Dentally does not expose it through the connection we have, " +
      "so this tab cannot tell you whether this patient has any. Check Dentally before treating this patient.",
    willHold:
      "When it is available, this tab will hold the medical history form, alerts, allergies, medications " +
      "and the date it was last updated.",
  },
  {
    slug: "chart",
    label: "Chart",
    availability: "unreadable",
    cannotRead:
      "We cannot read the tooth chart. Dentally does not expose charting through the connection we have.",
    willHold:
      "When it is built, this tab will hold the full FDI chart, upper and lower, with a crown diagram and " +
      "surfaces grid per tooth, the treatment code list and plan templates, BPE, history and the base chart, " +
      "and it will write back to Dentally.",
  },
  {
    slug: "appointments",
    label: "Appointments",
    availability: "live",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "recalls",
    label: "Recalls",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "notes",
    label: "Notes",
    availability: "live",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "account",
    label: "Account",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "perio",
    label: "Perio",
    availability: "unreadable",
    cannotRead:
      "We cannot read periodontal charting. Dentally does not expose it through the connection we have.",
    willHold:
      "When it is built, this tab will hold BPE scores and the pocket chart, with the date of each assessment.",
  },
  {
    slug: "correspondence",
    label: "Correspondence",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "tasks",
    label: "Tasks",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
  {
    slug: "audit",
    label: "Audit",
    availability: "partial",
    cannotRead: "",
    willHold: "",
  },
] as const;

/** True when `raw` is one of the eleven. Anything else must 404, never fall back to
 *  Details: a mistyped tab that silently shows a different one is how a reader ends
 *  up believing they checked something they did not. */
export function isPatientTab(raw: string): raw is PatientTabSlug {
  return (PATIENT_TAB_SLUGS as readonly string[]).includes(raw);
}

export function patientTab(slug: PatientTabSlug): PatientTab {
  // Non-null by construction: PATIENT_TABS covers every slug, and a test holds it.
  return PATIENT_TABS.find((t) => t.slug === slug) as PatientTab;
}

/** The tab's own URL under a record base path (which already ends in the patient id).
 *  Details is the record root rather than /details, so the default tab has one URL. */
export function patientTabHref(basePath: string, slug: PatientTabSlug): string {
  return slug === "details" ? basePath : `${basePath}/${slug}`;
}

// ---------------------------------------------------------------------------
// The reusable empty and failed sentences, so no panel invents its own wording.
// ---------------------------------------------------------------------------

/** Category A: a real read returned nothing. */
export const EMPTY_COPY = {
  appointments: "No appointments on record.",
  recalls: "No recall dates on this patient's record.",
  practiceNotes: "No practice notes yet. Add the first one above.",
  dentallyNotes: "No clinical notes in Dentally.",
  plans: "No treatment plans on record.",
  invoices: "No invoices on record.",
  // Worded so it cannot be read as "this patient has never been contacted".
  correspondence: "No messages have been sent to this patient from this platform.",
  tasks: "No open tasks for this patient.",
  // Worded so it cannot be read as "nothing has ever happened to this record",
  // which is the failure mode the Audit tab is most prone to.
  audit: "No changes have been made to this patient through this platform.",
} as const;

/**
 * Category D: a read we DO have threw. Never the same sentence as category A.
 *
 * THE FOUR AT THE BOTTOM WERE MISSING, and their absence was the defect: the
 * correspondence, tasks, audit, recall and status reads each caught to an empty array
 * or a null, and the panel then printed the category A sentence. A Supabase blip or an
 * RLS regression during a complaint investigation put "No messages have been sent to
 * this patient from this platform" on the screen, in writing, as a fact about the
 * patient. An outage must never be able to make a positive claim about a record.
 */
export const FAILED_COPY = {
  appointments: "We could not read this patient's appointments just now.",
  plans: "We could not read this patient's treatment plans just now.",
  dentallyNotes: "We could not read Dentally's clinical notes just now.",
  invoices: "We could not read this patient's invoices just now.",
  correspondence:
    "We could not read this patient's message history just now, so this is NOT a record of what was sent. " +
    "Check the Conversations inbox before assuming this patient has not been contacted.",
  partialCorrespondence:
    "Part of this patient's message history could not be read just now, so messages may be missing from this list.",
  tasks: "We could not read this patient's tasks just now, so this is not a complete list of open work.",
  audit: "We could not read this patient's change history just now.",
  recalls: "We could not read the recall worklist just now, so we cannot say whether this patient is on it.",
  status:
    "We could not read this patient's status just now, so we cannot show whether the practice has marked them " +
    "inactive or do-not-contact. Check before contacting this patient.",
  statusChip: "Status not read",
} as const;

/** Category C: on our own side, and stated as one quiet line, never a row of chips. */
export const NOT_HELD_COPY = {
  detailsFields:
    "Dentally's own record also holds a middle name, preferred name, NI and NHS numbers, town, county, " +
    "home and work phone, the assigned dentist and hygienist, recall intervals, recall method and " +
    "acquisition source. We do not read those fields yet, so they are not shown.",
  recallIntervals:
    "Dentally also records a recall interval and a recall method. We do not read those yet, so they are not shown.",
  badDebtor: "Dentally's 'Set bad debtor' marker has no equivalent here yet.",
} as const;

/** Category B, inline: things a panel that DOES render must still say it cannot reach. */
export const CANNOT_READ_COPY = {
  invoiceColumns:
    "Summary, practitioners and location are not returned by the invoice read we have, so those columns are blank.",
  payments:
    "Payment and allocation history is not shown. Dentally's payments endpoint cannot be filtered to one patient, " +
    "so listing it here would mean reading the whole site's payment history every time this record is opened.",
  dentallyCorrespondence:
    "Letters, and any SMS or email sent from Dentally itself, are not shown. Dentally does not expose its " +
    "correspondence through the connection we have.",
  dentallyTasks: "Dentally's own task list is not readable.",
  dentallyAudit:
    "This is a record of changes made through this platform. Anything done inside Dentally itself, including " +
    "logins, record views, appointment edits and note edits, is not shown: Dentally does not expose its audit " +
    "trail through the connection we have.",
  taskScope:
    "Shows recall, no-show and reactivation tasks. Coordinator, after-hours, speed-to-lead and smile assessment " +
    "tasks are not keyed to a patient, so they cannot be listed here.",
  medicalHistoryFlag: "Medical history not read",
} as const;
