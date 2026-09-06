import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { INTEREST_QUESTION_KEY, INTEREST_TREATMENTS } from "@/lib/triage/bank";
import { URGENT_HELP_THRESHOLD, urgentHelpLine } from "@/lib/triage/copy";
import { projectBank } from "@/lib/triage/project";
import type { ProjectedQuestion } from "@/lib/triage/project";
import { PreVisitDone, PreVisitFormView, hasUrgentScore } from "./previsit-form";

// ===========================================================================
// WHICH SCALE EARNS THE SEVERE-PAIN LINE.
//
// `urgentHelpLine` is the sentence "If you're in severe pain right now, please
// call the practice on <number>. Outside opening hours, call 111 for urgent
// dental advice." It is the practice's whole duty to a patient who has just told
// us their discomfort is a 9 (W1-C/3), and nothing in this module acts on that 9
// by itself.
//
// It is therefore a sentence about DISCOMFORT, and it must be attached to the
// classification, not to the widget. `hasUrgentScore` used to key on
// `q.type === "scale"` alone, and a 0-10 is the only scale this module renders,
// so it fired for EVERY 0-10 question — including ones the owner classified
// `cosmetic` or `logistics`, which `usableCustom` accepts (CUSTOM_TYPES x
// CUSTOM_KINDS is a full cross-product) and which `admit` therefore lets onto the
// BRIEF bank, since neither is `kind === "symptom"` and neither need carry a
// forbidden term.
//
// The consequence was the exact thing the brief fork exists to prevent: a patient
// the server deliberately never asked about pain rates "How confident do you feel
// about your smile?" a 9 and is handed a severe-pain notice, on the form and again
// on the way out.
//
// THE OTHER HALF OF THAT DISAGREEMENT HAS SINCE BEEN FIXED TOO, and this note used
// to describe only the old state. `projectSummary` once read the discomfort flag
// off the shipped `pain-now` key alone, so the record for that patient said
// `discomfortReported: false` and the practice never learned it happened. It no
// longer does: `highestDiscomfort` (src/lib/triage/summary.ts) takes the top scale
// across the `clinical` lines — which are exactly the symptom-kind ones — and
// raises the flag at DISCOMFORT_NOTICE_THRESHOLD. So both halves are now keyed on
// the SAME classification, and the pair of rules below is what keeps them there.
//
// THE RULE: a scale earns the line when it is classified `symptom`. That keeps
// the reason the any-scale read was written in the first place — "a practice can
// add a scale question of its own and a high score on it deserves the same
// sentence" — for the case it was written for (an owner-authored discomfort
// scale, which is symptom-kind), and it makes the line UNREACHABLE on the brief
// bank by construction rather than by hope, because `admit` already refuses
// symptom-kind questions there.
// ===========================================================================

const NEEDLE = "call 111 for urgent dental advice";
const HIGH = String(URGENT_HELP_THRESHOLD + 2);

function scale(key: string, label: string, kind: ProjectedQuestion["kind"]): ProjectedQuestion {
  return { key, label, type: "scale", kind, required: false, custom: true };
}

function renderForm(questions: ProjectedQuestion[], answers: Record<string, string>): string {
  return renderToStaticMarkup(
    createElement(PreVisitFormView, {
      practiceName: "N15 Vitality Dental",
      questions,
      interest: INTEREST_TREATMENTS,
      answers,
      interestAnswers: {},
      status: "idle" as const,
      error: null,
      outstanding: 0,
      practicePhone: "020 8808 8484",
      onAnswer: () => {},
      onInterest: () => {},
      onSubmit: () => {},
    }),
  );
}

function renderDone(questions: ProjectedQuestion[], answers: Record<string, string>): string {
  return renderToStaticMarkup(
    createElement(PreVisitDone, {
      medicalLink: null,
      questions,
      answers,
      practicePhone: "020 8808 8484",
    }),
  );
}

describe("the severe-pain line follows the classification, not the widget", () => {
  it("a cosmetic or logistics 0-10 is REACHABLE on the brief bank", () => {
    // Not a hypothetical: this is the input that makes the coupling wrong, so it
    // is built through the REAL projection rather than asserted about. If a future
    // change stops admitting these, this test says so out loud instead of
    // silently protecting nothing.
    const projected = projectBank("brief", {
      enabledKeys: [INTEREST_QUESTION_KEY],
      required: {},
      custom: [
        {
          key: "custom-smile-confidence",
          label: "How confident do you feel about your smile?",
          type: "scale",
          kind: "cosmetic",
          required: false,
        },
        {
          key: "custom-travel-ease",
          label: "How easy is it for you to get to us?",
          type: "scale",
          kind: "logistics",
          required: false,
        },
      ],
    });
    const keys = projected.questions.map((q) => q.key);
    expect(keys, "a cosmetic 0-10 should still reach the short form").toContain("custom-smile-confidence");
    expect(keys, "a logistics 0-10 should still reach the short form").toContain("custom-travel-ease");
    expect(projected.dropped, "nothing about these two questions is refusable").toEqual([]);
  });

  it("a high score on a cosmetic or logistics scale shows NO severe-pain line", () => {
    for (const kind of ["cosmetic", "logistics"] as const) {
      const q = scale(`custom-${kind}`, "How confident do you feel about your smile?", kind);
      expect(hasUrgentScore([q], { [q.key]: HIGH }), `a ${kind} scale scored ${HIGH} claimed urgency`).toBe(false);
      expect(renderForm([q], { [q.key]: HIGH }), `a ${kind} scale printed the line under the question`).not.toContain(
        NEEDLE,
      );
      expect(renderDone([q], { [q.key]: HIGH }), `a ${kind} scale printed the line on the way out`).not.toContain(
        NEEDLE,
      );
    }
  });

  it("an owner-authored SYMPTOM scale still shows it, which is why the read is not narrowed to pain-now", () => {
    const q = scale("custom-ache", "How bad is the ache when you bite?", "symptom");
    expect(hasUrgentScore([q], { [q.key]: HIGH })).toBe(true);
    expect(hasUrgentScore([q], { [q.key]: String(URGENT_HELP_THRESHOLD - 1) })).toBe(false);
    const markup = renderForm([q], { [q.key]: HIGH });
    expect(markup).toContain(NEEDLE);
    // The whole sentence, minus its apostrophe, which React escapes in static
    // markup. The site's own number is in it: never invented, never a default.
    expect(markup).toContain(urgentHelpLine("020 8808 8484").replace("you're", "you&#x27;re"));
    expect(renderDone([q], { [q.key]: HIGH })).toContain(NEEDLE);
  });

  it("a cosmetic scale beside a symptom one does not suppress the real line", () => {
    // The fix must not become "the first scale wins" in either direction.
    const cosmetic = scale("custom-smile", "How confident do you feel about your smile?", "cosmetic");
    const symptom = scale("custom-ache", "How bad is the ache when you bite?", "symptom");
    expect(hasUrgentScore([cosmetic, symptom], { "custom-smile": "1", "custom-ache": HIGH })).toBe(true);
    expect(hasUrgentScore([cosmetic, symptom], { "custom-smile": HIGH, "custom-ache": "1" })).toBe(false);
  });

  it("the brief bank cannot show the line at all, whatever the patient taps", () => {
    // The end-to-end property, stated as itself: project the short bank with every
    // scale an owner could put on it, answer every one at the top of the range,
    // and no patient on that fork is told about severe pain.
    const projected = projectBank("brief", {
      enabledKeys: [INTEREST_QUESTION_KEY],
      required: {},
      custom: [
        { key: "custom-smile-confidence", label: "How confident do you feel about your smile?", type: "scale", kind: "cosmetic", required: false },
        { key: "custom-travel-ease", label: "How easy is it for you to get to us?", type: "scale", kind: "logistics", required: false },
      ],
    });
    const answers: Record<string, string> = {};
    for (const q of projected.questions) answers[q.key] = "10";
    expect(hasUrgentScore(projected.questions, answers)).toBe(false);
    expect(renderForm(projected.questions, answers)).not.toContain(NEEDLE);
    expect(renderDone(projected.questions, answers)).not.toContain(NEEDLE);
  });
});
