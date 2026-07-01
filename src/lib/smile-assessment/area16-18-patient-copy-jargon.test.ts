// AREA 16+18: guard against NHS / private / funding jargon leaking into ANY
// patient-facing copy on the public smile-assessment quiz and onboarding forms.
//
// The rule (per project policy): patient-facing messages must never say NHS or
// private, and must never expose internal targeting/funding framing. The quiz DOES
// ask how a patient would like to fund treatment (finance / plan) — that is a
// patient's own choice and is fine — but the forbidden tokens are NHS and private.

import { describe, it, expect } from "vitest";
import { QUIZ_QUESTIONS } from "./quiz";
import { ONBOARDING_STEPS } from "@/lib/onboarding/steps";
import { ONBOARDING_LIBRARY } from "@/lib/onboarding/library";

// Case-insensitive whole-word matches for the forbidden framing.
const FORBIDDEN = [/\bNHS\b/i, /\bprivate\b/i, /\bprivately\b/i];

function assertClean(label: string, text: string): void {
  for (const re of FORBIDDEN) {
    expect(re.test(text), `"${label}" -> "${text}" contains forbidden jargon ${re}`).toBe(false);
  }
}

describe("no NHS/private jargon in smile-assessment patient copy", () => {
  it("quiz prompts + option labels are clean", () => {
    for (const q of QUIZ_QUESTIONS) {
      assertClean(q.id, q.prompt);
      for (const o of q.options) assertClean(`${q.id}.${o.value}`, o.label);
    }
  });
});

describe("no NHS/private jargon in onboarding patient copy", () => {
  it("step titles + field labels + select option labels are clean", () => {
    for (const step of ONBOARDING_STEPS) {
      assertClean(step.id, step.title);
      for (const f of step.fields) {
        assertClean(f.key, f.label);
        for (const o of f.options ?? []) assertClean(`${f.key}.${o.value}`, o.label);
      }
    }
  });

  it("library question labels + option labels are clean", () => {
    for (const q of ONBOARDING_LIBRARY) {
      assertClean(q.key, q.label);
      for (const o of q.options ?? []) assertClean(`${q.key}.${o.value}`, o.label);
    }
  });
});
