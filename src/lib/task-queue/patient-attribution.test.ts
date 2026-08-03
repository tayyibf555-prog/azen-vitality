import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * The patient record's Tasks tab lists a patient's own open work. That is only safe
 * if a task's patientId is EXACT.
 *
 * These assertions read the generator's source rather than running it, because the
 * generators are all `server-only` repository calls and the property under test is a
 * property of the code, not of any particular row: which modules attribute a patient,
 * and that none of them ever derives one from a name.
 *
 * Matching a task to a patient by name on a clinical record would put another
 * person's work on this record the first time two patients share a name.
 */
const SRC = readFileSync(fileURLToPath(new URL("./generate.ts", import.meta.url)), "utf8");

// One `patientId:` line per candidate builder, in file order.
const ASSIGNMENTS = [...SRC.matchAll(/patientId:\s*([^,\n]+)/g)].map((m) => m[1].trim());

describe("task -> patient attribution", () => {
  it("assigns a patientId in every candidate builder, so none can be forgotten", () => {
    // seven modules: speed-to-lead, recall, reactivation, coordinator, noshow,
    // after-hours, smile-assessment.
    expect(ASSIGNMENTS).toHaveLength(7);
  });

  it("derives it ONLY from a target's own dentallyPatientId, or leaves it null", () => {
    for (const value of ASSIGNMENTS) {
      expect(value === "null" || /^[a-z]\.dentallyPatientId$/.test(value)).toBe(true);
    }
  });

  it("NEVER derives it from patientName, a name, or a free-text field", () => {
    for (const value of ASSIGNMENTS) {
      expect(value).not.toMatch(/name/i);
    }
  });

  it("keys exactly the four modules whose targets carry a patient id", () => {
    const keyed = ASSIGNMENTS.filter((v) => v !== "null");
    // recall, reactivation, no-show and after-hours. The first three always carry
    // a dentallyPatientId; an after-hours capture carries one whenever the caller
    // was identified by phone number, and null when they were not.
    expect(keyed).toHaveLength(4);
  });

  it("surfaces the after-hours capture's own dentallyPatientId, so an identified caller's callback reaches their record", () => {
    // The capture row HAS carried this id since the module shipped: both webhooks
    // resolve the caller through identifyByPhone and store it, and the repository
    // maps it back. The generator was dropping it on the floor, which unlinked
    // every callback task for a patient we had already recognised.
    const afterHours = /function afterHoursCandidates[\s\S]*?patientId:\s*([^,\n]+)/.exec(SRC);
    expect(afterHours?.[1].trim()).toBe("c.dentallyPatientId");
  });
});
