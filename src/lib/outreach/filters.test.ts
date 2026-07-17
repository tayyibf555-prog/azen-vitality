// Pure segment-matching logic. No Dentally, no DB: exercises the exact functions
// the build route feeds patient-list fields and appointment history.
import { describe, it, expect } from "vitest";
import {
  prefilterPatient,
  prefilterOutcome,
  matchAppointmentHistory,
  hasAppointmentSince,
  matchedReasonLabel,
  lookbackDays,
  type PatientLike,
  type AppointmentLike,
} from "./filters";
import type { OutreachFilters } from "./types";

const NOW = new Date("2026-07-16T12:00:00Z");
const DAY = 86_400_000;
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString();
}

function patient(over: Partial<PatientLike> = {}): PatientLike {
  return { active: true, phone: "07700900000", lastVisitAt: daysAgo(200), ...over };
}

// The client-test segment: a private hygiene clean in the last ~3 years but not the
// last 3 months. Expressed as a last-visit window (cheap pre-filter) plus a
// treatment + recency filter on appointment history.
const HYGIENE_FILTERS: OutreachFilters = {
  lastVisitAfter: daysAgo(1095),
  lastVisitBefore: daysAgo(90),
  treatmentContains: ["hygiene", "scale", "polish"],
  treatmentLookbackDays: 1095,
  excludeSeenSinceDays: 90,
  requiresMobile: true,
};

describe("prefilterPatient", () => {
  it("passes an active patient with a mobile whose last visit is in the window", () => {
    expect(prefilterPatient(patient({ lastVisitAt: daysAgo(200) }), HYGIENE_FILTERS)).toBe(true);
  });

  it("rejects an archived / inactive patient", () => {
    expect(prefilterPatient(patient({ active: false }), HYGIENE_FILTERS)).toBe(false);
  });

  it("rejects a patient with no mobile when requiresMobile is on", () => {
    expect(prefilterPatient(patient({ phone: null }), HYGIENE_FILTERS)).toBe(false);
    expect(prefilterPatient(patient({ phone: "  " }), HYGIENE_FILTERS)).toBe(false);
  });

  it("allows a missing mobile when requiresMobile is off", () => {
    expect(prefilterPatient(patient({ phone: null }), { requiresMobile: false })).toBe(true);
  });

  it("rejects a last visit more recent than lastVisitBefore (seen in the last 3 months)", () => {
    expect(prefilterPatient(patient({ lastVisitAt: daysAgo(30) }), HYGIENE_FILTERS)).toBe(false);
  });

  it("rejects a last visit older than lastVisitAfter (more than 3 years ago)", () => {
    expect(prefilterPatient(patient({ lastVisitAt: daysAgo(1200) }), HYGIENE_FILTERS)).toBe(false);
  });

  it("rejects an unknown last visit when a window is set (cannot place them in it)", () => {
    expect(prefilterPatient(patient({ lastVisitAt: null }), HYGIENE_FILTERS)).toBe(false);
  });

  it("ignores the last-visit window when neither bound is set", () => {
    expect(prefilterPatient(patient({ lastVisitAt: null }), { treatmentContains: ["hygiene"] })).toBe(true);
  });
});

describe("prefilterOutcome (age + gender demographics)", () => {
  // NOW is 2026-07-16; born 1990-01-01 => age 36.
  const base: PatientLike = { active: true, phone: "07700900000", lastVisitAt: daysAgo(200) };

  it("passes a patient inside an age range", () => {
    const out = prefilterOutcome({ ...base, dateOfBirth: "1990-01-01" }, { ageMin: 30, ageMax: 40 }, NOW);
    expect(out).toEqual({ pass: true, excludedForMissingData: false });
  });

  it("rejects (no missing-data flag) a patient outside the age range", () => {
    const out = prefilterOutcome({ ...base, dateOfBirth: "1990-01-01" }, { ageMin: 40, ageMax: 50 }, NOW);
    expect(out.pass).toBe(false);
    expect(out.excludedForMissingData).toBe(false);
  });

  it("EXCLUDES a patient with no DOB and flags missing data when an age filter is set", () => {
    const out = prefilterOutcome({ ...base, dateOfBirth: null }, { ageMin: 30, ageMax: 40 }, NOW);
    expect(out.pass).toBe(false);
    expect(out.excludedForMissingData).toBe(true);
  });

  it("passes a matching gender and rejects a non-matching one", () => {
    expect(prefilterOutcome({ ...base, gender: "female" }, { gender: "female" }, NOW).pass).toBe(true);
    const wrong = prefilterOutcome({ ...base, gender: "male" }, { gender: "female" }, NOW);
    expect(wrong.pass).toBe(false);
    expect(wrong.excludedForMissingData).toBe(false);
  });

  it("EXCLUDES a patient with no gender and flags missing data when a gender filter is set", () => {
    const out = prefilterOutcome({ ...base, gender: null }, { gender: "female" }, NOW);
    expect(out.pass).toBe(false);
    expect(out.excludedForMissingData).toBe(true);
  });

  it("does not flag missing data when no demographic filter is set", () => {
    const out = prefilterOutcome({ ...base, dateOfBirth: null, gender: null }, { treatmentContains: ["hygiene"] }, NOW);
    expect(out).toEqual({ pass: true, excludedForMissingData: false });
  });

  it("counts missing-demographic exclusion only AFTER the cheap gates (inactive is a plain reject)", () => {
    const out = prefilterOutcome({ ...base, active: false, gender: null }, { gender: "female" }, NOW);
    expect(out.pass).toBe(false);
    expect(out.excludedForMissingData).toBe(false); // rejected for inactive, not missing gender
  });

  it("applies age bounds inclusively at both ends", () => {
    // age 36 exactly at both bounds.
    expect(prefilterOutcome({ ...base, dateOfBirth: "1990-01-01" }, { ageMin: 36, ageMax: 36 }, NOW).pass).toBe(true);
  });
});

describe("hasAppointmentSince", () => {
  it("is true for a recent past appointment inside the window", () => {
    expect(hasAppointmentSince([{ start: daysAgo(30), reason: "Exam" }], 90, NOW)).toBe(true);
  });
  it("is true for a FUTURE appointment (already engaged)", () => {
    expect(hasAppointmentSince([{ start: daysAgo(-5), reason: "Exam" }], 90, NOW)).toBe(true);
  });
  it("is false when the only appointment is older than the window", () => {
    expect(hasAppointmentSince([{ start: daysAgo(120), reason: "Exam" }], 90, NOW)).toBe(false);
  });
});

describe("matchAppointmentHistory", () => {
  const oldHygiene: AppointmentLike = { start: daysAgo(300), reason: "Scale & Polish" };

  it("matches an old hygiene clean and labels it", () => {
    const m = matchAppointmentHistory([oldHygiene, { start: daysAgo(305), reason: "Exam" }], HYGIENE_FILTERS, NOW);
    expect(m.matched).toBe(true);
    expect(m.matchedReason).toMatch(/Scale & Polish/);
  });

  it("excludes a patient seen within excludeSeenSinceDays even if they also match", () => {
    const m = matchAppointmentHistory([oldHygiene, { start: daysAgo(20), reason: "Filling" }], HYGIENE_FILTERS, NOW);
    expect(m.matched).toBe(false);
    expect(m.excludedReason).toBe("seen_recently");
  });

  it("excludes a patient with an upcoming booking", () => {
    const m = matchAppointmentHistory([oldHygiene, { start: daysAgo(-3), reason: "Exam" }], HYGIENE_FILTERS, NOW);
    expect(m.matched).toBe(false);
    expect(m.excludedReason).toBe("seen_recently");
  });

  it("does not match when no appointment reason contains a needle", () => {
    const m = matchAppointmentHistory(
      [{ start: daysAgo(300), reason: "Exam" }, { start: daysAgo(400), reason: "Filling" }],
      HYGIENE_FILTERS,
      NOW,
    );
    expect(m.matched).toBe(false);
    expect(m.excludedReason).toBe("no_treatment_match");
  });

  it("matches case-insensitively", () => {
    const m = matchAppointmentHistory([{ start: daysAgo(200), reason: "HYGIENE visit" }], HYGIENE_FILTERS, NOW);
    expect(m.matched).toBe(true);
  });

  it("ignores a matching appointment outside the lookback window", () => {
    const m = matchAppointmentHistory(
      [{ start: daysAgo(1200), reason: "Scale & Polish" }],
      { ...HYGIENE_FILTERS, lastVisitAfter: undefined, lastVisitBefore: undefined },
      NOW,
    );
    expect(m.matched).toBe(false);
  });

  it("with no treatment filter, any past visit in the window qualifies", () => {
    const m = matchAppointmentHistory(
      [{ start: daysAgo(200), reason: "Exam" }],
      { treatmentLookbackDays: 1095 },
      NOW,
    );
    expect(m.matched).toBe(true);
    expect(m.matchedReason).toMatch(/Exam/);
  });

  it("picks the MOST RECENT qualifying visit for the label", () => {
    const m = matchAppointmentHistory(
      [
        { start: daysAgo(700), reason: "Scale & Polish" },
        { start: daysAgo(200), reason: "Scale & Polish" },
      ],
      HYGIENE_FILTERS,
      NOW,
    );
    // daysAgo(200) from a 2026-07-16 now is 2025-12-28.
    expect(m.matchedReason).toContain("2025");
  });
});

describe("matchedReasonLabel + lookbackDays", () => {
  it("formats a British-style date label", () => {
    expect(matchedReasonLabel({ start: "2025-03-14T09:00:00Z", reason: "Scale & Polish" })).toBe(
      "Scale & Polish 14 Mar 2025",
    );
  });
  it("defaults the lookback to ~3 years", () => {
    expect(lookbackDays({})).toBe(1095);
    expect(lookbackDays({ treatmentLookbackDays: 365 })).toBe(365);
    expect(lookbackDays({ treatmentLookbackDays: 0 })).toBe(1095);
  });
});
