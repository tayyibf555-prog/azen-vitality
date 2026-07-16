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
  /** True once every site's patient base has been fully scanned. */
  done: boolean;
  /** Patients scanned so far (all sites). */
  scanned: number;
  /** Candidates that passed the cheap pre-filter (all sites). */
  candidates: number;
  /** Targets matched + enrolled so far (all sites). */
  matched: number;
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
