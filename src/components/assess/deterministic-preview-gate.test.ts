// THE PREVIEW GATE ON THE DETERMINISTIC FUNNEL.
//
// campaigns-panel.tsx embeds the live public page in an iframe so an owner can
// click through their own funnel (assessment-live-preview.tsx). The sandbox is
// `allow-scripts allow-same-origin allow-forms`, which is only safe because
// ?preview=1 hard-gates the two things that reach the outside world:
//
//   telemetry  a no-op tracker, never createFunnelTracker, so an owner clicking
//              through a preview never pollutes the funnel analytics the
//              practice makes decisions on.
//   submit     the POST is refused, so a preview can never write a real
//              smile_assessment_response, create a real lead, or fire the real
//              speed-to-lead SMS (submit/route.ts:291).
//
// ClassicAssessmentQuiz has honoured this since it shipped. DeterministicAssessmentQuiz
// is a SECOND copy of the same plumbing (it exists because the mode branch has to
// happen at the mount boundary), and a second copy is exactly where a gate gets
// left out. Nothing tested it until this file.
//
// TECHNIQUE. vitest collects only src/**/*.test.ts in a node env, so the
// component is verified the way guided-assessment-shell.test.ts verifies its own:
// its source is read as text for the structural gates, and renderToStaticMarkup
// proves the component really mounts and walks the funnel (a static render only
// ever reaches phase "question", so the contact form is asserted through source).

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DeterministicAssessmentQuiz } from "./deterministic-assessment-quiz";
import { templateForGoal } from "@/lib/smile-assessment/flow-templates";
import { toPublicFlow, type PublicFlow } from "@/lib/smile-assessment/campaign";
import { walkFlow } from "@/lib/smile-assessment/flow-runtime";

const DETERMINISTIC_PATH = fileURLToPath(
  new URL("./deterministic-assessment-quiz.tsx", import.meta.url),
);
const CLASSIC_PATH = fileURLToPath(new URL("./assessment-quiz.tsx", import.meta.url));

const source = readFileSync(DETERMINISTIC_PATH, "utf8");
const classic = readFileSync(CLASSIC_PATH, "utf8");

const SUBMIT_URL = '"/api/smile-assessment/submit"';

/** A real published funnel, built the way the runtime gets one. */
function publishedFlow(): PublicFlow {
  const flow = toPublicFlow(templateForGoal("invisalign").build());
  if (!flow) throw new Error("the invisalign template no longer builds a public flow");
  return flow;
}

function render(previewMode: boolean): string {
  return renderToStaticMarkup(
    createElement(DeterministicAssessmentQuiz, {
      clientSlug: "vitality",
      campaignSlug: "invisalign",
      practiceName: "Vitality Dental",
      flow: publishedFlow(),
      previewMode,
    }),
  );
}

/**
 * The source between a function's header and the first line that reaches the
 * network. Whatever guards the call has to live in here.
 */
function beforeFirstCall(header: string, call: string): string {
  const start = source.indexOf(header);
  expect(start, `${header} is no longer in the source`).toBeGreaterThan(-1);
  const end = source.indexOf(call, start);
  expect(end, `${call} is not reached from ${header}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/* ---------------------------------------------------------------------------
 * 1. Telemetry
 * ------------------------------------------------------------------------- */

describe("preview mode never emits funnel telemetry", () => {
  it("builds a no-op tracker instead of the real one, in the lazy initialiser", () => {
    // Anchored on the whole expression: dropping the ternary, inverting it, or
    // moving createFunnelTracker outside it all fail here.
    expect(source).toMatch(
      /const \[tracker\] = useState<FunnelTracker>\(\(\) =>\s*previewMode\s*\?\s*\{\s*track:\s*\(\)\s*=>\s*\{\},\s*flush:\s*\(\)\s*=>\s*\{\}\s*\}\s*:\s*createFunnelTracker\(/,
    );
  });

  it("has exactly one construction of the real tracker, and it is the gated one", () => {
    const calls = source.match(/createFunnelTracker\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // Everything downstream goes through `tracker`, so gating the construction
    // gates every track() call there is or ever will be.
    expect(source).not.toMatch(/createFunnelTracker\([^)]*\)\.track/);
    expect(source.match(/tracker\.track\(/g)?.length ?? 0).toBeGreaterThan(2);
  });

  it("gates it exactly the way the Classic quiz does, so the two cannot drift", () => {
    const gate = /previewMode\s*\?\s*\{\s*track:\s*\(\)\s*=>\s*\{\},\s*flush:\s*\(\)\s*=>\s*\{\}\s*\}\s*:\s*createFunnelTracker\(/;
    expect(classic, "the Classic gate this one is copied from moved").toMatch(gate);
    expect(source).toMatch(gate);
  });
});

/* ---------------------------------------------------------------------------
 * 2. Submit
 * ------------------------------------------------------------------------- */

describe("preview mode never posts a real submission", () => {
  it("refuses inside submit() before anything is fetched", () => {
    const guard = beforeFirstCall("async function submit(", "await fetch(");
    // The guard has to mention previewMode AND return; a guard that only checks
    // canSubmit/busy would still let an Enter-key submit through in preview.
    expect(guard).toMatch(/if\s*\([^)]*previewMode[^)]*\)\s*return;/);
  });

  it("guards the submit POST itself, not merely the token fetch that precedes it", () => {
    const guard = beforeFirstCall("async function submit(", SUBMIT_URL);
    expect(guard).toMatch(/if\s*\([^)]*previewMode[^)]*\)\s*return;/);
    // And the POST exists exactly once, so there is no second, ungated path to it.
    expect(source.match(/\/api\/smile-assessment\/submit/g)).toHaveLength(1);
  });

  it("also disables the button, so the gate is defence in depth rather than one line", () => {
    expect(source).toMatch(/disabled=\{!canSubmit \|\| busy \|\| previewMode\}/);
    expect(source).toContain("Preview mode. Submissions are disabled here.");
  });

  it("tells the owner why, rather than showing a dead button with the consent line", () => {
    // The consent sentence is a promise to the patient; showing it in a preview
    // that cannot submit would be the wrong copy on the wrong screen.
    const notice = source.indexOf("Preview mode. Submissions are disabled here.");
    const consent = source.indexOf("By sending this you agree we can contact you");
    expect(notice).toBeGreaterThan(-1);
    expect(consent).toBeGreaterThan(-1);
    expect(source.slice(0, notice)).toMatch(/\{previewMode \? \($/m);
  });
});

/* ---------------------------------------------------------------------------
 * 3. The gate changes nothing the patient sees
 * ------------------------------------------------------------------------- */

describe("the funnel itself renders identically either way", () => {
  const previewHtml = render(true);
  const liveHtml = render(false);

  it("mounts and walks the authored funnel to its first question", () => {
    // Vacuity guard: if the component had failed to walk the graph this would be
    // an empty shell and every assertion above would be about dead code.
    const walk = walkFlow(publishedFlow().graph, {});
    expect(walk.status).toBe("ask");
    const first = publishedFlow().questions.find(
      (q) => q.id === (walk.status === "ask" ? walk.node.questionId : ""),
    );
    expect(first, "the funnel's opening question is not in its own payload").toBeTruthy();
    expect(previewHtml).toContain(first!.prompt);
    expect(previewHtml).toContain("Question 1");
  });

  it("shows the owner exactly what a patient sees", () => {
    // A preview that rendered differently would be worth nothing as a preview.
    expect(previewHtml).toBe(liveHtml);
  });

  it("puts the preview notice on the contact step only, never on a question screen", () => {
    expect(previewHtml).not.toContain("Preview mode. Submissions are disabled here.");
  });

  it("ships no scoring weight to the browser, in either mode", () => {
    // toPublicFlow maps options field by field for this reason; the render is the
    // last place to catch a regression that put the model back on the wire.
    expect(previewHtml).not.toMatch(/weight/i);
    expect(JSON.stringify(publishedFlow())).not.toMatch(/weight/i);
  });
});
