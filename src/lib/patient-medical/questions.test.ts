import { describe, it, expect } from "vitest";
import {
  MEDICAL_QUESTIONS,
  QUESTION_BANK_VERSION,
  isKnownQuestionKey,
  questionForKey,
  questionKeys,
} from "./questions";

// ===========================================================================
// The bank is DATA on a clinical record, so it is tested like data on a clinical
// record: the keys are unique and stable, the version is present on every stored
// answer set, and the standard UK dental screen is actually covered rather than
// gestured at.
// ===========================================================================

describe("the medical-history question bank", () => {
  it("has a dated version string, because a stored answer set records which one it answered", () => {
    expect(QUESTION_BANK_VERSION).toMatch(/^uk-dental-mh-\d{4}-\d{2}-\d{2}$/);
  });

  it("gives every question a unique key, so an answer references exactly one question", () => {
    const keys = questionKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never ships an empty prompt, because a blank yes/no question means nothing", () => {
    for (const q of MEDICAL_QUESTIONS) {
      expect(q.key.length, `${q.key} has no key`).toBeGreaterThan(0);
      expect(q.prompt.trim().length, `${q.key} has no prompt`).toBeGreaterThan(0);
      // A whole question, not a label — it ends in a question mark.
      expect(q.prompt.trim().endsWith("?"), `${q.key} is not phrased as a question`).toBe(true);
    }
  });

  /**
   * The clinical floor. These are the screening items a UK dental medical history
   * cannot omit; a bank that quietly dropped one would still pass every other test
   * here, so the standard is pinned by name.
   */
  it("covers the standard UK dental screen: heart, anticoagulants, diabetes, epilepsy, asthma, allergies, pregnancy, bisphosphonates, steroids, bleeding, BBV", () => {
    const keys = new Set(questionKeys());
    for (const required of [
      "heart_condition",
      "anticoagulants",
      "diabetes",
      "epilepsy_or_fainting",
      "asthma_or_breathing",
      "allergy_penicillin",
      "allergy_latex",
      "pregnant_or_breastfeeding",
      "bisphosphonates",
      "steroids",
      "bleeding_disorder",
      "blood_borne_infection",
    ]) {
      expect(keys.has(required), `the bank is missing ${required}`).toBe(true);
    }
  });

  it("carries NO NHS-vs-private funding framing anywhere — these are clinical questions the patient answers", () => {
    for (const q of MEDICAL_QUESTIONS) {
      expect(q.prompt).not.toMatch(/\bNHS\b/i);
      expect(q.prompt).not.toMatch(/\bprivate\b/i);
    }
  });

  it("recognises its own keys and rejects anything else", () => {
    expect(isKnownQuestionKey("diabetes")).toBe(true);
    expect(isKnownQuestionKey("not_a_real_key")).toBe(false);
    expect(isKnownQuestionKey("")).toBe(false);
    expect(questionForKey("diabetes")?.group).toBe("endocrine");
    expect(questionForKey("nope")).toBeNull();
  });
});
