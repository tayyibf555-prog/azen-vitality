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
    // ten modules: speed-to-lead, recall, reactivation, coordinator, noshow,
    // after-hours, smile-assessment (high band), smile-assessment (medium band),
    // agent escalations, medical-history.
    expect(ASSIGNMENTS).toHaveLength(10);
  });

  it("derives it ONLY from a target's own dentallyPatientId, or leaves it null", () => {
    for (const value of ASSIGNMENTS) {
      const direct = /^[a-z]\.dentallyPatientId$/.test(value);
      // The ONE permitted wrapper, and it only ever NARROWS: realPatientId returns
      // null for a synthetic key and the id itself otherwise. Any other expression
      // around the field has to be justified here before it can ship.
      const narrowed = /^realPatientId\([a-z]\.dentallyPatientId\)$/.test(value);
      expect(value === "null" || direct || narrowed).toBe(true);
    }
  });

  it("NEVER derives it from patientName, a name, or a free-text field", () => {
    for (const value of ASSIGNMENTS) {
      expect(value).not.toMatch(/name/i);
    }
  });

  it("keys exactly the six modules whose targets carry a patient id", () => {
    const keyed = ASSIGNMENTS.filter((v) => v !== "null");
    // recall, reactivation, no-show, after-hours, agent escalations and
    // medical-history. All carry a dentallyPatientId on the stored row (an
    // after-hours capture carries one whenever the caller was identified by phone,
    // and null when they were not; an agent conversation carries one whenever the
    // number resolved to a patient, and a `lead:<phone>` key when it did not).
    expect(keyed).toHaveLength(6);
  });

  it("surfaces the after-hours capture's own dentallyPatientId, so an identified caller's callback reaches their record", () => {
    // The capture row HAS carried this id since the module shipped: both webhooks
    // resolve the caller through identifyByPhone and store it, and the repository
    // maps it back. The generator was dropping it on the floor, which unlinked
    // every callback task for a patient we had already recognised.
    const afterHours = /function afterHoursCandidates[\s\S]*?patientId:\s*([^,\n]+)/.exec(SRC);
    expect(afterHours?.[1].trim()).toBe("c.dentallyPatientId");
  });

  it("puts an escalation on a record ONLY through realPatientId, never the raw conversation key", () => {
    // agent_conversation.dentally_patient_id holds a real patient id OR a synthetic
    // `lead:<phone>`. Passing the raw column would put a phone number where a patient
    // id belongs. This is the assertion that keeps the wrapper on.
    const escalation = /function agentEscalationCandidates[\s\S]*?patientId:\s*([^,\n]+)/.exec(SRC);
    expect(escalation?.[1].trim()).toBe("realPatientId(c.dentallyPatientId)");
  });

  it("keeps both assessment bands unattributed, because an enquiry has no patient id at all", () => {
    for (const fn of ["smileAssessmentCandidates", "mediumAssessmentCandidates"]) {
      const m = new RegExp(`function ${fn}[\\s\\S]*?patientId:\\s*([^,\\n]+)`).exec(SRC);
      expect(m?.[1].trim()).toBe("null");
    }
  });
});
