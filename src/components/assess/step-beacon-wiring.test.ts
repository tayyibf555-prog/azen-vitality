// THE BEACON, INSIDE THE QUIZ. step-beacon.test.ts holds what the beacon does;
// step-numbering.test.ts holds what the ordinals mean. This file holds the seam
// between them: that the DETERMINISTIC runtime, and only it, creates a beacon,
// feeds it ordinals from the shared numbering, and is inert in preview.
//
// TECHNIQUE, and its honest limit. vitest runs environment:"node" and collects
// only src/**/*.test.ts, so renderToStaticMarkup is the most a .tsx gets here — and
// a static render runs NO effects, which is exactly where the view() calls live
// (deterministic-preview-gate.test.ts:20-25 says the same about its own gates). So
// the render proves the component still mounts and walks the funnel with the new
// props, and the structural claims are read out of the source as text. The
// BEHAVIOUR those calls depend on — which ordinal a screen has — is tested for real
// in step-numbering.test.ts, against walkFlow itself.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLOW_SCHEMA_VERSION, type FlowGraph } from "@/lib/smile-assessment/flow";
import { toPublicFlow } from "@/lib/smile-assessment/campaign";
import { DeterministicAssessmentQuiz } from "./deterministic-assessment-quiz";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "deterministic-assessment-quiz.tsx"), "utf8");

/** Source with comments stripped: what the file DOES, not what it explains. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const GRAPH: FlowGraph = {
  schemaVersion: FLOW_SCHEMA_VERSION,
  entry: "w",
  nodes: [
    { kind: "welcome", id: "w", headline: "Straighter teeth", intro: "Two minutes." },
    { kind: "question", id: "q1", questionId: "treatment_interest" },
    { kind: "contact", id: "c" },
    { kind: "outcome", id: "hot", band: "high", headline: "A great fit" },
    { kind: "outcome", id: "mid", band: "medium", headline: "Worth a look" },
    { kind: "outcome", id: "cold", band: "low", headline: "Worth a chat" },
  ],
  edges: [
    { from: "w", to: "q1", answer: null },
    { from: "q1", to: "c", answer: null },
    { from: "c", to: "hot", answer: "high" },
    { from: "c", to: "mid", answer: "medium" },
    { from: "c", to: "cold", answer: "low" },
  ],
};

function render(props: { previewMode?: boolean; flowVersion?: number } = {}): string {
  const flow = toPublicFlow(GRAPH);
  if (!flow) throw new Error("fixture graph names a question that is not in the bank");
  return renderToStaticMarkup(
    createElement(DeterministicAssessmentQuiz, {
      clientSlug: "vitality",
      campaignSlug: "spring-implants",
      practiceName: "Vitality Dental",
      flow,
      ...props,
    }),
  );
}

describe("the deterministic quiz still mounts with the version it now carries", () => {
  // MUTATION: make flowVersion required, or read it off something that can be
  // undefined at mount. This is a PUBLIC, paid ad-destination page; a throw here is
  // a blank screen for a patient who clicked an advert.
  it("renders the funnel's first screen with a version", () => {
    const html = render({ flowVersion: 7 });
    expect(html).toContain("Straighter teeth");
    expect(html).toContain("Vitality Dental");
  });

  it("renders identically without one, rather than refusing to start", () => {
    expect(render()).toBe(render({ flowVersion: undefined }));
  });

  it("still renders in preview mode", () => {
    expect(render({ previewMode: true, flowVersion: 7 })).toContain("Straighter teeth");
  });
});

describe("what the quiz is wired to emit", () => {
  // MUTATION: derive the ordinal here — history.length, or phoneFlowLayout's step
  // chip. Both are already in the tree and neither is a screen ordinal; a second
  // derivation is a chart quietly describing the wrong screens.
  it("takes every ordinal from the shared numbering, and computes none itself", () => {
    expect(CODE).toContain('from "@/lib/smile-assessment/step-numbering"');
    expect(CODE).toContain("stepNumbering(flow.graph)");
    expect(CODE).toContain("stepIndexOf(numbering, current.nodeId)");
    expect(CODE).toContain("numbering.contactStep");
    expect(CODE).toContain("numbering.outcomeStep");
  });

  // MUTATION: keep the tracker's preview gate and forget the beacon's. An owner
  // clicking through the inline preview would then fill the practice's own
  // drop-off chart with sessions that were never patients.
  it("is inert in preview mode, the same way the funnel tracker is", () => {
    expect(CODE).toMatch(/previewMode\s*\?\s*INERT_BEACON/);
  });

  // MUTATION: pass a placeholder version when the page did not supply one. Rows
  // filed under a version that does not exist are rows no chart can ever read;
  // createStepBeacon refuses -1 and goes inert instead.
  it("refuses to invent a flow version", () => {
    expect(CODE).toContain("flowVersion: flowVersion ?? -1");
  });

  // MUTATION: emit while degraded. If walkFlow could not route a session the
  // component finishes it on the ADAPTIVE funnel, whose screens come from the model
  // and have no ordinal in the drawn graph.
  it("emits nothing once the session has fallen back to the adaptive funnel", () => {
    expect(CODE).toMatch(/if \(mode !== "flow"\) return;/);
  });

  // MUTATION: rely on the debounce for the last screen. The result screen is the
  // one the whole chart is about, and it is the one a page navigating away eats.
  it("flushes on the result screen rather than leaving it queued", () => {
    const effect = CODE.slice(CODE.indexOf('if (mode !== "flow") return;'));
    expect(effect.slice(0, effect.indexOf("}, ["))).toContain("beacon.flush()");
  });
});

describe("the page hands the version down", () => {
  // MUTATION: let the browser choose the version (a query string, a data attribute).
  // flow_version decides which tally a row lands in; a caller-chosen one lets
  // anybody write into any version's numbers.
  it("passes flowVersion from the server alongside the flow it describes", () => {
    const page = readFileSync(
      join(HERE, "..", "..", "app", "assess", "[client]", "[slug]", "page.tsx"),
      "utf8",
    );
    expect(page).toContain("flowVersion={campaign.flowVersion}");
  });
});
