import { londonDayKey } from "@/lib/time/london";

// Pure patient-demographic helpers shared by the Dentally patient mapper, the outreach
// segment pre-filter and the segment builder. No I/O; callers pass `now`.

export type Gender = "male" | "female";

/**
 * Normalise a raw Dentally `gender` value to 'male' | 'female' | null.
 *
 * THE LIVE ENCODING IS A BOOLEAN, and this function used to drop it on the floor.
 * PROBE 2026-08-17 (GET /v1/patients, 800 real records for this practice): `gender`
 * came back as a boolean on 100% of them — 0 strings, 0 integers — with true = male
 * (Mr 227/232 true, Master 23/23 true; Mrs/Miss/Ms 0/387 true). Before this fix a
 * boolean fell past the string and number branches and returned null, so against
 * LIVE data every patient read as "no gender on file", while the local mock (which
 * serialises "Male"/"Female" strings) worked perfectly. Mock green, production
 * silently wrong — the same shape of defect as the createPatient 422, except this
 * one throws nothing: an outreach campaign with a gender filter set would match
 * ZERO patients and report them all as excluded-for-missing-data
 * (lib/outreach/filters.ts), which reads like a true finding about the practice.
 *
 * The historical string ("Male"/"Female") and ISO/IEC 5218 integer (1 = male,
 * 2 = female) encodings are kept: the mock still emits strings, and neither costs
 * anything. Anything else is null, so an unrecognised value is treated as "not on
 * file" (excluded when a gender filter is set) rather than mis-targeted.
 *
 * NOTE for live calibration: the integer mapping follows ISO/IEC 5218 and remains
 * UNCONFIRMED against the real key — no live record has ever carried one.
 */
export function normaliseGender(raw: unknown): Gender | null {
  // FIRST, because it is the only encoding live Dentally actually uses.
  if (typeof raw === "boolean") return raw ? "male" : "female";
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
