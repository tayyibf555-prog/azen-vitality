// AREA 16+18: guard against NHS / private / funding jargon leaking into ANY
// patient-facing copy on the public smile-assessment quiz and onboarding forms.
//
// The rule (per project policy): patient-facing messages must never say NHS or
// private, and must never expose internal targeting/funding framing. The quiz DOES
// ask how a patient would like to fund treatment (finance / plan) — that is a
// patient's own choice and is fine — but the forbidden tokens are NHS and private.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("no NHS/private jargon in the Guided assessment quiz's static copy", () => {
  // The Guided quiz (src/components/assess/guided-assessment-quiz.tsx) is a new,
  // original-design public surface (intro screen, big tappable tiles, results
  // reveal, contact step) whose copy is hand-written JSX text rather than data
  // in QUIZ_QUESTIONS, so it cannot be walked like the bank above. Reading the
  // component's own source as text still lets this guard catch a forbidden
  // token landing in any of its patient-facing strings, the same way the seed
  // tests read a migration file as text (see hygiene-seed-content.test.ts).
  //
  // option-images.ts is on the list for the same reason and then some: it holds
  // the tiles' ALT TEXT and their asset paths, both of which reach the patient's
  // DOM, and neither of which lives in QUIZ_QUESTIONS either.
  const GUIDED_SOURCES = [
    "src/components/assess/guided-assessment-quiz.tsx",
    "src/components/assess/option-images.ts",
  ];

  for (const path of GUIDED_SOURCES) {
    it(`reads ${path} and finds no forbidden jargon`, () => {
      const src = readFileSync(resolve(process.cwd(), path), "utf8");
      for (const re of FORBIDDEN) {
        expect(re.test(src), `${path} contains forbidden jargon ${re}`).toBe(false);
      }
    });
  }
});
