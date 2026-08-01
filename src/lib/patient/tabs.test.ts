import { describe, it, expect } from "vitest";
import {
  CANNOT_READ_COPY,
  EMPTY_COPY,
  FAILED_COPY,
  PATIENT_TABS,
  PATIENT_TAB_SLUGS,
  isPatientTab,
  patientTab,
  patientTabHref,
} from "./tabs";

describe("the eleven tabs", () => {
  it("are in Dentally's exact order", () => {
    expect([...PATIENT_TAB_SLUGS]).toEqual([
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
    ]);
  });

  it("has one definition per slug, in the same order", () => {
    expect(PATIENT_TABS.map((t) => t.slug)).toEqual([...PATIENT_TAB_SLUGS]);
    for (const slug of PATIENT_TAB_SLUGS) {
      expect(patientTab(slug).slug).toBe(slug);
      expect(patientTab(slug).label.length).toBeGreaterThan(0);
    }
  });

  it("recognises only those eleven slugs", () => {
    expect(isPatientTab("appointments")).toBe(true);
    expect(isPatientTab("Appointments")).toBe(false);
    expect(isPatientTab("charting")).toBe(false);
    expect(isPatientTab("")).toBe(false);
  });

  it("puts Details at the record root rather than at /details", () => {
    expect(patientTabHref("/c/vitality/patients/42", "details")).toBe("/c/vitality/patients/42");
    expect(patientTabHref("/c/vitality/patients/42", "perio")).toBe("/c/vitality/patients/42/perio");
  });
});

// The test that stops the three honesty sentences drifting into each other.
describe("the honesty copy", () => {
  const unreadable = PATIENT_TABS.filter((t) => t.availability === "unreadable");

  it("covers Medical, Chart and Perio, the three with no source at all", () => {
    expect(unreadable.map((t) => t.slug)).toEqual(["medical", "chart", "perio"]);
  });

  it.each(unreadable)("$slug says it cannot read, and never that there is none", (tab) => {
    expect(tab.cannotRead).toContain("cannot read");
    // "recorded" and "none" are the two words that turn "we cannot read this" into
    // "this patient has none of this", which is the confusion the rule forbids.
    expect(tab.cannotRead.toLowerCase()).not.toContain("recorded");
    expect(tab.cannotRead.toLowerCase()).not.toContain("none");
    expect(tab.willHold.length).toBeGreaterThan(0);
  });

  it("tells a clinician to check Dentally before treating, on the medical tab only", () => {
    expect(patientTab("medical").cannotRead).toContain("Check Dentally before treating this patient");
  });

  it("keeps the empty and failed sentences distinct for every stream that has both", () => {
    expect(EMPTY_COPY.appointments).not.toBe(FAILED_COPY.appointments);
    expect(EMPTY_COPY.dentallyNotes).not.toBe(FAILED_COPY.dentallyNotes);
    expect(EMPTY_COPY.plans).not.toBe(FAILED_COPY.plans);
    expect(EMPTY_COPY.invoices).not.toBe(FAILED_COPY.invoices);
  });

  it("phrases the correspondence and audit empties so they cannot be read too widely", () => {
    // "No messages" alone would read as "this patient has never been contacted".
    expect(EMPTY_COPY.correspondence).toContain("from this platform");
    // "No changes" alone would read as "nothing has ever happened to this record".
    expect(EMPTY_COPY.audit).toContain("through this platform");
  });

  it("keeps the header's medical flag neutral in wording", () => {
    expect(CANNOT_READ_COPY.medicalHistoryFlag).toBe("Medical history not read");
  });

  it("uses British English and no em-dash anywhere in the copy", () => {
    const all = [
      ...PATIENT_TABS.flatMap((t) => [t.cannotRead, t.willHold, t.label]),
      ...Object.values(EMPTY_COPY),
      ...Object.values(FAILED_COPY),
      ...Object.values(CANNOT_READ_COPY),
    ];
    for (const s of all) {
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/\borganiz|\bcolor\b|\bcanceled\b/);
    }
  });
});
