import { londonDayKey } from "@/lib/time/london";

// Pure patient-demographic helpers shared by the Dentally patient mapper, the outreach
// segment pre-filter and the segment builder. No I/O; callers pass `now`.

export type Gender = "male" | "female";

/**
 * Normalise a raw Dentally `gender` value to 'male' | 'female' | null. Dentally has
 * carried gender as a string ("Male"/"Female") historically; some deployments encode
 * it as an ISO/IEC 5218 integer (1 = male, 2 = female). We handle both defensively and
 * return null for anything unknown or unset, so an unrecognised value is treated as
 * "not on file" (excluded when a gender filter is set) rather than mis-targeted.
 *
 * NOTE for live calibration: the integer mapping follows ISO/IEC 5218; confirm against
 * the real key before relying on numeric gender codes.
 */
export function normaliseGender(raw: unknown): Gender | null {
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "") return null;
    if (s === "f" || s === "female" || s === "woman" || s === "w" || s === "2") return "female";
    if (s === "m" || s === "male" || s === "man" || s === "1") return "male";
    return null;
  }
  if (typeof raw === "number") {
    if (raw === 1) return "male";
    if (raw === 2) return "female";
    return null;
  }
  return null;
}

/** Pull the calendar Y/M/D out of a date-only or full-ISO string, avoiding TZ shifts. */
function ymd(s: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Whole-years age from a date of birth, measured against the Europe/London calendar
 * day of `now` (so a birthday flips at London midnight, not UTC). Returns null when the
 * DOB is missing or unparseable, or lies in the future. Leap-year and birthday-boundary
 * correct: the year rolls over only once month/day reach the birth month/day.
 */
export function ageFromDob(dob: string | null | undefined, now: Date): number | null {
  if (!dob) return null;
  const b = ymd(dob);
  if (!b) return null;
  const t = ymd(londonDayKey(now));
  if (!t) return null;
  const [by, bm, bd] = b;
  const [ny, nm, nd] = t;
  let age = ny - by;
  if (nm < bm || (nm === bm && nd < bd)) age -= 1;
  return age < 0 ? null : age;
}
