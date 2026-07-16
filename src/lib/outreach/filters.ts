// Pure segment-matching logic for the outreach builder.
//
// These functions carry NO I/O so they are unit-testable without Dentally. The
// build route feeds them patient-list fields (cheap pre-filter) and, for the
// survivors only, per-patient appointment history (the expensive stage).
//
// Two narrow local shapes keep this module free of the Dentally runtime; the real
// PatientRecord / AppointmentRecord are structurally compatible supersets.

import type { OutreachFilters } from "./types";

const DAY_MS = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 1095; // ~3 years

export interface PatientLike {
  active: boolean;
  phone: string | null;
  lastVisitAt: string | null;
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

/**
 * The cheap gate applied to a raw patient-list record BEFORE any per-patient
 * appointment read. Narrows the whole base (tens of thousands) down to plausible
 * candidates so the expensive history reads only ever touch a small slice.
 *
 * Rejects: archived/inactive patients (never message someone who has left, moved
 * away or died); patients with no mobile when requiresMobile is on; and anyone
 * whose last visit falls outside the [lastVisitAfter, lastVisitBefore] window
 * when either bound is set (a missing last-visit date fails a bounded window,
 * since we cannot place them in it).
 */
export function prefilterPatient(patient: PatientLike, filters: OutreachFilters): boolean {
  if (!patient.active) return false;

  const requiresMobile = filters.requiresMobile ?? true;
  if (requiresMobile && !(patient.phone && patient.phone.trim())) return false;

  const hasWindow = Boolean(filters.lastVisitAfter || filters.lastVisitBefore);
  if (hasWindow) {
    const lv = ms(patient.lastVisitAt);
    if (Number.isNaN(lv)) return false; // cannot place an unknown last visit in a bounded window
    if (filters.lastVisitAfter) {
      const after = ms(filters.lastVisitAfter);
      if (!Number.isNaN(after) && lv < after) return false;
    }
    if (filters.lastVisitBefore) {
      const before = ms(filters.lastVisitBefore);
      if (!Number.isNaN(before) && lv > before) return false;
    }
  }
  return true;
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
