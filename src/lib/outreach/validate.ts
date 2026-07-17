import type { OutreachFilters } from "./types";

// Server-side validation + plain-English description of an outreach segment. Kept
// pure (no I/O) so both the campaigns API and the co-pilot tool share one definition
// of a valid filter shape and one way to read a segment back to the owner.

export const DAILY_CAP_MIN = 1;
export const DAILY_CAP_MAX = 100;

// Sane bounds for the age pre-filter (a dental list never needs an age outside this).
export const AGE_MIN = 0;
export const AGE_MAX = 120;

/** A hygiene-recall keyword preset offered as a one-tap default in the builder. */
export const HYGIENE_PRESET_KEYWORDS = ["hygiene", "scale", "polish", "scale & polish", "hygienist"];

export type FilterParse =
  | { ok: true; filters: OutreachFilters }
  | { ok: false; error: string };

/** A calendar date (YYYY-MM-DD) or a full ISO instant parses to a real time. */
function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || v.trim() === "") return false;
  const t = Date.parse(v);
  return !Number.isNaN(t);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * Validate a raw filters object from a request body into a clean OutreachFilters.
 * Rejects the wrong SHAPE (a non-array treatmentContains, an unparseable date, a
 * non-integer day count) rather than silently coercing, so a malformed segment can
 * never reach the builder. Every field is optional; an empty object is valid (the
 * whole active base, paced by the cap).
 */
export function parseFilters(raw: unknown): FilterParse {
  const f = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: OutreachFilters = {};

  if (f.lastVisitAfter !== undefined && f.lastVisitAfter !== null && f.lastVisitAfter !== "") {
    if (!isIsoDate(f.lastVisitAfter)) return { ok: false, error: "lastVisitAfter must be an ISO date" };
    out.lastVisitAfter = f.lastVisitAfter as string;
  }
  if (f.lastVisitBefore !== undefined && f.lastVisitBefore !== null && f.lastVisitBefore !== "") {
    if (!isIsoDate(f.lastVisitBefore)) return { ok: false, error: "lastVisitBefore must be an ISO date" };
    out.lastVisitBefore = f.lastVisitBefore as string;
  }
  if (
    out.lastVisitAfter &&
    out.lastVisitBefore &&
    Date.parse(out.lastVisitAfter) > Date.parse(out.lastVisitBefore)
  ) {
    return { ok: false, error: "lastVisitAfter must be on or before lastVisitBefore" };
  }

  if (f.treatmentContains !== undefined && f.treatmentContains !== null) {
    if (!Array.isArray(f.treatmentContains)) return { ok: false, error: "treatmentContains must be an array of strings" };
    const items = f.treatmentContains
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 20);
    if (items.length > 0) out.treatmentContains = items;
  }

  if (f.treatmentLookbackDays !== undefined && f.treatmentLookbackDays !== null && f.treatmentLookbackDays !== "") {
    if (!isInt(f.treatmentLookbackDays) || f.treatmentLookbackDays <= 0) {
      return { ok: false, error: "treatmentLookbackDays must be a positive whole number of days" };
    }
    out.treatmentLookbackDays = f.treatmentLookbackDays;
  }

  if (f.excludeSeenSinceDays !== undefined && f.excludeSeenSinceDays !== null && f.excludeSeenSinceDays !== "") {
    if (!isInt(f.excludeSeenSinceDays) || f.excludeSeenSinceDays < 0) {
      return { ok: false, error: "excludeSeenSinceDays must be a whole number of days (0 or more)" };
    }
    if (f.excludeSeenSinceDays > 0) out.excludeSeenSinceDays = f.excludeSeenSinceDays;
  }

  if (f.requiresMobile !== undefined && f.requiresMobile !== null) {
    if (typeof f.requiresMobile !== "boolean") return { ok: false, error: "requiresMobile must be true or false" };
    out.requiresMobile = f.requiresMobile;
  }

  // Age bounds (inclusive whole years). Either bound may be set alone.
  if (f.ageMin !== undefined && f.ageMin !== null && f.ageMin !== "") {
    if (!isInt(f.ageMin) || f.ageMin < AGE_MIN || f.ageMin > AGE_MAX) {
      return { ok: false, error: `ageMin must be a whole number between ${AGE_MIN} and ${AGE_MAX}` };
    }
    out.ageMin = f.ageMin;
  }
  if (f.ageMax !== undefined && f.ageMax !== null && f.ageMax !== "") {
    if (!isInt(f.ageMax) || f.ageMax < AGE_MIN || f.ageMax > AGE_MAX) {
      return { ok: false, error: `ageMax must be a whole number between ${AGE_MIN} and ${AGE_MAX}` };
    }
    out.ageMax = f.ageMax;
  }
  if (out.ageMin !== undefined && out.ageMax !== undefined && out.ageMin > out.ageMax) {
    return { ok: false, error: "ageMin must be on or below ageMax" };
  }

  if (f.gender !== undefined && f.gender !== null && f.gender !== "") {
    const g = typeof f.gender === "string" ? f.gender.trim().toLowerCase() : "";
    if (g !== "female" && g !== "male") return { ok: false, error: "gender must be 'female' or 'male'" };
    out.gender = g;
  }

  return { ok: true, filters: out };
}

/** Validate a daily cap into the allowed range, defaulting when unset. */
export function parseDailyCap(raw: unknown, fallback = 25): { ok: true; dailyCap: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, dailyCap: fallback };
  if (!isInt(raw)) return { ok: false, error: "dailyCap must be a whole number" };
  if (raw < DAILY_CAP_MIN || raw > DAILY_CAP_MAX) {
    return { ok: false, error: `dailyCap must be between ${DAILY_CAP_MIN} and ${DAILY_CAP_MAX}` };
  }
  return { ok: true, dailyCap: raw };
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * A plain-English description of a segment, for reading back to the owner (co-pilot
 * launch read-back, UI summaries). Deliberately avoids any funding/clinical wording;
 * it describes the SELECTION, not a patient message.
 */
export function describeSegment(filters: OutreachFilters): string {
  const parts: string[] = [];
  if (filters.gender) parts.push(filters.gender === "female" ? "female patients" : "male patients");

  if (filters.ageMin !== undefined && filters.ageMax !== undefined) {
    parts.push(`aged ${filters.ageMin} to ${filters.ageMax}`);
  } else if (filters.ageMin !== undefined) {
    parts.push(`aged ${filters.ageMin} or over`);
  } else if (filters.ageMax !== undefined) {
    parts.push(`aged ${filters.ageMax} or under`);
  }

  const treatments = filters.treatmentContains ?? [];
  if (treatments.length > 0) {
    parts.push(`had ${treatments.map((t) => `"${t}"`).join(" or ")} on a past appointment`);
  } else {
    parts.push("any past appointment");
  }
  if (filters.lastVisitAfter && filters.lastVisitBefore) {
    parts.push(`last seen between ${shortDate(filters.lastVisitAfter)} and ${shortDate(filters.lastVisitBefore)}`);
  } else if (filters.lastVisitAfter) {
    parts.push(`last seen on or after ${shortDate(filters.lastVisitAfter)}`);
  } else if (filters.lastVisitBefore) {
    parts.push(`last seen on or before ${shortDate(filters.lastVisitBefore)}`);
  }
  if (filters.excludeSeenSinceDays && filters.excludeSeenSinceDays > 0) {
    parts.push(`not seen or booked in the last ${filters.excludeSeenSinceDays} days`);
  }
  if (filters.requiresMobile === false) {
    parts.push("mobile number not required");
  } else {
    parts.push("has a mobile number");
  }

  let out = parts.join("; ");
  // Honesty note: when a demographic filter is on, records missing that datum are
  // dropped, so the read-back should say so.
  if (filters.gender || filters.ageMin !== undefined || filters.ageMax !== undefined) {
    out += " (records with no recorded age or gender on file are not included)";
  }
  return out;
}
