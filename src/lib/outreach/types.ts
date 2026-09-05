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
 *
 * ---------------------------------------------------------------------------
 * NOT HERE, ON PURPOSE: an `interestIn` predicate (ledger, ruling W3/10).
 * ---------------------------------------------------------------------------
 * Every filter above selects against DENTALLY's patient base — appointment
 * reason text, last-visit dates, DOB, gender. None of them can see the
 * platform's own `treatment_interest` rows, so the practice cannot build "the
 * people who ticked implants on the pre-visit form" as a campaign here.
 *
 * W3/10 sets the floor at owner+manager CSV export / copy-as-audience on the
 * interest-lists screen, and that is LANDED (see the note in
 * src/components/client/previsit/interest-export.test.ts) — the ruling's own
 * words are "anything larger -> ledger with sizing", and this is the ledger.
 *
 * SIZING, if the client wants the list targetable in-platform rather than via
 * a file:
 *   - `interestIn?: InterestTreatmentKey[]` here;
 *   - `parseFilters` in ./validate.ts accepts it against the four known keys
 *     (whitening | straightening | implants | veneers-bonding) and rejects
 *     anything else, exactly as it does treatmentContains;
 *   - ONE repository read in build.ts before the page loop — the same shape as
 *     the exclusion load: `listInterest({ siteIds: [siteId], answer: 'yes' })`
 *     paged to exhaustion into a Set of dentally_patient_ids — plus one cheap
 *     membership test in the pre-filter (before the appointment read, like the
 *     exclusion check). It must page to exhaustion for the reason the exclusion
 *     read does: a clipped read silently narrows the audience with no error;
 *   - a segment field in the co-pilot's create_outreach_campaign and a control
 *     in the campaigns workspace, or the filter has no caller (W3/8) and is not
 *     shipped;
 *   - consent and the daily cap are untouched: an interest tick is not consent,
 *     and the send path still decides.
 * Deliberately NOT added as a dormant field: a filter nothing can set is dead
 * weight that reads like a capability.
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
  /**
   * Of the matched targets, how many have SMS consent on file (from the Dentally
   * `use_sms` flag captured at build time). This is the CONTACTABLE reality: consent is
   * applied at send time, so a matched-but-not-consented patient is enrolled + counted
   * but never texted. Surfaced in the read-back so "N match" is not read as "N reached".
   */
  contactable?: number;
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
  /**
   * Optional SECOND message angle. When set, the campaign is a two-message A/B test:
   * each patient is deterministically assigned one angle (see src/lib/outreach/variant.ts)
   * and the detail reads back sent/replied/booked per angle. Null keeps the campaign
   * single-message (everyone is variant 'a').
   */
  messageAngleB: string | null;
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
  /**
   * A/B variant, assigned at draft time for a two-angle campaign and never changed.
   * Null until the target is first drafted, and always 'a' for a single-angle campaign.
   */
  variant: "a" | "b" | null;
  currentStep: number;       // last completed step; 0 = enrolled, none sent
  nextDueAt: string | null;  // ISO; null when terminal
  startedAt: string | null;
  endedAt: string | null;
  /** Durable stamp of the FIRST reply tied to this target (once). Null until they reply. */
  repliedAt: string | null;
  /** Durable stamp of the booking attributed to this target (once). Null until booked. */
  bookedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
