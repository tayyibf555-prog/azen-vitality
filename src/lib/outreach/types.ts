// Segment outreach domain types.
//
// The channel / touch / cadence-status unions are shared with reactivation so the
// reused outbox + drain contracts stay identical (exactly as recall does). Outreach
// adds its own campaign + target shapes. A target carries its OWN cadence position
// (currentStep / nextDueAt) because there is no separate cadence table: a campaign
// enrolment is a one-off, not a re-synced Dentally record.

export type {
  TouchChannel,
  TouchStatus,
  CadenceStatus,
  DraftedBy,
} from "@/lib/reactivation/types";

// draft   -> owner is still building the segment definition
// building-> the build job is scanning the patient base
// ready   -> targets are filled, awaiting the owner to start sending
// running -> the sweep is enrolling + sending
// paused  -> temporarily halted by the owner (no drafting/queueing)
// done    -> finished (all targets settled, or the owner closed it)
export type OutreachCampaignStatus =
  | "draft"
  | "building"
  | "ready"
  | "running"
  | "paused"
  | "done";

// pending   -> enrolled, cadence started, no touch queued yet
// queued    -> reserved for a future finer UI state (not written by the v1 engine)
// contacted -> at least one touch has been queued/sent
// replied   -> the patient replied; cadence paused (see the inbound webhook)
// booked    -> the patient booked in (the agent's book tool succeeded)
// excluded  -> will not be contacted (no consent at send time, or suppressed)
// exhausted -> the 3-touch cadence ran out without a reply/booking
export type OutreachTargetStatus =
  | "pending"
  | "queued"
  | "contacted"
  | "replied"
  | "booked"
  | "excluded"
  | "exhausted";

/**
 * Segment definition, stored on the campaign as jsonb. v1 filters:
 * - lastVisitAfter / lastVisitBefore: ISO dates bounding the patient's last visit.
 * - treatmentContains: case-insensitive substrings matched against a patient's
 *   appointment reason text within `treatmentLookbackDays`.
 * - treatmentLookbackDays: how far back to read appointment history (default 3y).
 * - excludeSeenSinceDays: drop anyone with ANY appointment in the last N days.
 * - requiresMobile: require a mobile number (default true).
 * - ageMin / ageMax: inclusive whole-years age bounds, computed from the patient's
 *   date of birth against the Europe/London current date. CHEAP pre-filters (no
 *   appointment read). A patient with no DOB on file is EXCLUDED when either is set.
 * - gender: 'female' | 'male'. CHEAP pre-filter. A patient with no gender on file is
 *   EXCLUDED when set. (Excluded-for-missing-data is counted, for an honest read-back.)
 *
 * Consent is deliberately NOT a build filter: it is decided at send time (the
 * sweep checks the snapshot, the drain re-checks suppression live).
 */
export interface OutreachFilters {
  lastVisitAfter?: string;
  lastVisitBefore?: string;
  treatmentContains?: string[];
  treatmentLookbackDays?: number;
  excludeSeenSinceDays?: number;
  requiresMobile?: boolean;
  ageMin?: number;
  ageMax?: number;
  gender?: "female" | "male";
}

/**
 * The resumable build cursor, stored on the campaign row. Tracks per-site page
 * position so a bounded build job can be re-invoked and continue where it stopped,
 * plus running counters for the cached headline counts.
 */
export interface OutreachBuildCursor {
  /** Index into the campaign's site list currently being scanned. */
  siteIndex: number;
  /** Next patient-list page to fetch for the current site (1-based). */
  page: number;
  /**
   * Resume position WITHIN `page`: the number of leading rows of that page already
   * fully processed (counted + enrolled) on a prior tick. A mid-page budget or
   * 403/429 stop persists this so the next tick resumes at the unscanned tail rather
   * than re-reading the head (which would re-spend the appointment-read budget on
   * rows it already scanned and double-count them). 0 at every clean page boundary.
   */
  pageOffset?: number;
  /** True once every site's patient base has been fully scanned. */
  done: boolean;
  /** Patients scanned so far (all sites). */
  scanned: number;
  /** Candidates that passed the cheap pre-filter (all sites). */
  candidates: number;
  /** Targets matched + enrolled so far (all sites). */
  matched: number;
  /** Patients dropped ONLY because a set age/gender filter needed data not on file. */
  excludedMissingData?: number;
}

export interface OutreachCampaign {
  id: string;
  clientId: string;
  siteId: string;
  name: string;
  status: OutreachCampaignStatus;
  filters: OutreachFilters;
  practitionerId: string | null;
  practitionerName: string | null;
  messageAngle: string | null;
  dailyCap: number;
  buildCursor: OutreachBuildCursor | null;
  counts: Record<string, number> | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachTarget {
  id: string;
  campaignId: string;
  patientId: string;         // Dentally patient id
  name: string;
  phone: string | null;
  siteId: string;
  matchedReason: string | null;
  status: OutreachTargetStatus;
  consent: { sms: boolean; email: boolean; marketing: boolean };
  currentStep: number;       // last completed step; 0 = enrolled, none sent
  nextDueAt: string | null;  // ISO; null when terminal
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
