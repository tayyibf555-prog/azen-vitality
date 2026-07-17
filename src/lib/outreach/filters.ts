// Pure segment-matching logic for the outreach builder.
//
// These functions carry NO I/O so they are unit-testable without Dentally. The
// build route feeds them patient-list fields (cheap pre-filter) and, for the
// survivors only, per-patient appointment history (the expensive stage).
//
// Two narrow local shapes keep this module free of the Dentally runtime; the real
// PatientRecord / AppointmentRecord are structurally compatible supersets.

import type { OutreachFilters } from "./types";
import { ageFromDob, type Gender } from "@/lib/patient/demographics";

const DAY_MS = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 1095; // ~3 years

export interface PatientLike {
  active: boolean;
  phone: string | null;
  lastVisitAt: string | null;
  /** ISO date; used by the age pre-filter. Optional so pre-demographic callers/tests
   *  need not supply it (a missing DOB is excluded only when an age filter is set). */
  dateOfBirth?: string | null;
  /** Normalised gender; a missing value is excluded only when a gender filter is set. */
  gender?: Gender | null;
}

export interface AppointmentLike {
  start: string;         // ISO datetime
  reason: string | null; // Dentally appointment reason text (e.g. "Scale & Polish")
  state?: string;
}

/** Effective lookback window in days for treatment-history matching. */
export function lookbackDays(filters: OutreachFilters): number {
  const raw = filters.treatmentLookbackDays;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOOKBACK_DAYS;
}

/** Parse an ISO instant to ms; NaN for anything unparseable. */
function ms(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

export interface PrefilterOutcome {
  /** Whether the patient survives the cheap pre-filter (becomes a candidate). */
  pass: boolean;
  /**
   * True ONLY when the patient was rejected specifically because a set age or gender
   * filter required demographic data they do not have on file. Counted separately so
   * the campaign read-back can honestly say "N records had no recorded age/gender and
   * were not included". Never true for a plain no-match (wrong age/gender/window).
   */
  excludedForMissingData: boolean;
}

const PASS: PrefilterOutcome = { pass: true, excludedForMissingData: false };
const REJECT: PrefilterOutcome = { pass: false, excludedForMissingData: false };

/**
 * The cheap gate applied to a raw patient-list record BEFORE any per-patient
 * appointment read. Narrows the whole base (tens of thousands) down to plausible
 * candidates so the expensive history reads only ever touch a small slice.
 *
 * Rejects: archived/inactive patients (never message someone who has left, moved
 * away or died); patients with no mobile when requiresMobile is on; anyone whose last
 * visit falls outside the [lastVisitAfter, lastVisitBefore] window when either bound
 * is set (a missing last-visit date fails a bounded window); and, when an age/gender
 * filter is set, anyone outside the range OR with that datum missing. A missing
 * age/gender when the filter is set is flagged `excludedForMissingData` so it can be
 * counted for an honest read-back.
 *
 * The non-demographic gates run first, so `excludedForMissingData` only ever reflects
 * patients who would otherwise have been candidates but were dropped for missing
 * age/gender data (not inactive or no-mobile rows).
 */
export function prefilterOutcome(patient: PatientLike, filters: OutreachFilters, now: Date): PrefilterOutcome {
  if (!patient.active) return REJECT;

  const requiresMobile = filters.requiresMobile ?? true;
  if (requiresMobile && !(patient.phone && patient.phone.trim())) return REJECT;

  const hasWindow = Boolean(filters.lastVisitAfter || filters.lastVisitBefore);
  if (hasWindow) {
    const lv = ms(patient.lastVisitAt);
    if (Number.isNaN(lv)) return REJECT; // cannot place an unknown last visit in a bounded window
    if (filters.lastVisitAfter) {
      const after = ms(filters.lastVisitAfter);
      if (!Number.isNaN(after) && lv < after) return REJECT;
    }
    if (filters.lastVisitBefore) {
      const before = ms(filters.lastVisitBefore);
      if (!Number.isNaN(before) && lv > before) return REJECT;
    }
  }

  // Gender pre-filter. A set gender with no gender on file is an honest exclusion.
  if (filters.gender) {
    if (!patient.gender) return { pass: false, excludedForMissingData: true };
    if (patient.gender !== filters.gender) return REJECT;
  }

  // Age pre-filter (inclusive). A set age bound with no DOB on file is an honest
  // exclusion; an in-file DOB outside the range is a plain no-match.
  if (filters.ageMin !== undefined || filters.ageMax !== undefined) {
    const age = ageFromDob(patient.dateOfBirth ?? null, now);
    if (age === null) return { pass: false, excludedForMissingData: true };
    if (filters.ageMin !== undefined && age < filters.ageMin) return REJECT;
    if (filters.ageMax !== undefined && age > filters.ageMax) return REJECT;
  }

  return PASS;
}

/**
 * Boolean convenience over prefilterOutcome for callers that only need pass/fail.
 * `now` defaults to the current instant (age filters need a reference day); pass an
 * explicit `now` for deterministic tests.
 */
export function prefilterPatient(patient: PatientLike, filters: OutreachFilters, now: Date = new Date()): boolean {
  return prefilterOutcome(patient, filters, now).pass;
}

/** A patient-facing-safe label for a matched appointment, e.g. "Scale & Polish 14 Mar 2025". */
export function matchedReasonLabel(appt: AppointmentLike): string {
  const d = new Date(appt.start);
  const when = Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const what = (appt.reason && appt.reason.trim()) || "Appointment";
  return when ? `${what} ${when}` : what;
}

function reasonMatches(reason: string | null, needles: string[]): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return needles.some((n) => n && r.includes(n.toLowerCase()));
}

/**
 * Whether the patient has ANY appointment on or after (now - sinceDays). Covers
 * both a recent past visit AND an upcoming booking, so a patient already engaged
 * with the practice is never pulled into an outreach campaign. Used for
 * excludeSeenSinceDays.
 */
export function hasAppointmentSince(appts: AppointmentLike[], sinceDays: number, now: Date): boolean {
  if (!(sinceDays > 0)) return false;
  const cutoff = now.getTime() - sinceDays * DAY_MS;
  return appts.some((a) => {
    const t = ms(a.start);
    return !Number.isNaN(t) && t >= cutoff;
  });
}

export interface HistoryMatch {
  matched: boolean;
  matchedReason: string | null;
  /** Why it did not match, for diagnostics (not patient-facing). */
  excludedReason?: "seen_recently" | "no_treatment_match";
}

/**
 * Evaluate a pre-filtered patient's appointment history against the treatment /
 * recency filters. Returns whether they qualify and the human label for the
 * matched visit.
 *
 * Order matters: the recency EXCLUSION is checked first, so a patient seen (or
 * booked) within excludeSeenSinceDays is dropped even if they also have an older
 * qualifying visit. The treatment match then looks only at PAST appointments
 * within the lookback window; the most recent qualifying one supplies the label.
 * With no treatmentContains filter, any past visit in the lookback window
 * qualifies (the segment is defined by the last-visit window alone).
 */
export function matchAppointmentHistory(
  appts: AppointmentLike[],
  filters: OutreachFilters,
  now: Date,
): HistoryMatch {
  const excludeSince = filters.excludeSeenSinceDays;
  if (typeof excludeSince === "number" && excludeSince > 0 && hasAppointmentSince(appts, excludeSince, now)) {
    return { matched: false, matchedReason: null, excludedReason: "seen_recently" };
  }

  const back = lookbackDays(filters);
  const cutoff = now.getTime() - back * DAY_MS;
  const nowMs = now.getTime();

  // Past appointments within the lookback window, newest first.
  const pastInWindow = appts
    .filter((a) => {
      const t = ms(a.start);
      return !Number.isNaN(t) && t <= nowMs && t >= cutoff;
    })
    .sort((a, b) => ms(b.start) - ms(a.start));

  const needles = (filters.treatmentContains ?? []).filter((n) => n && n.trim());
  if (needles.length === 0) {
    // No treatment filter: the last-visit window is the whole definition.
    const latest = pastInWindow[0];
    if (!latest) return { matched: false, matchedReason: null, excludedReason: "no_treatment_match" };
    return { matched: true, matchedReason: matchedReasonLabel(latest) };
  }

  const hit = pastInWindow.find((a) => reasonMatches(a.reason, needles));
  if (!hit) return { matched: false, matchedReason: null, excludedReason: "no_treatment_match" };
  return { matched: true, matchedReason: matchedReasonLabel(hit) };
}
