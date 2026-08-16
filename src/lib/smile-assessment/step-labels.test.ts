// WHAT THE BARS ARE CALLED. A drop-off chart of "Step 1, Step 2, Step 3" answers
// nothing an owner asked — the whole question is WHICH screen loses people — so
// the labels are the load-bearing half of the chart, and they have to be the SAME
// words the builder's phone minis show.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { FLOW_SCHEMA_VERSION, type FlowGraph, type FlowNode, type FlowEdge } from "./flow";
import { screenFor } from "./flow-phone-screen";
import { questionById } from "./quiz";
import { stepNumbering } from "./step-numbering";
import { stepLabels, RESULT_STEP_LABEL } from "./step-labels";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "step-labels.ts"), "utf8");

const edge = (from: string, to: string, answer: string | null = null): FlowEdge => ({
  from,
  to,
  answer,
});

const NODES: FlowNode[] = [
  { kind: "welcome", id: "w", headline: "Straighter teeth in 2026", intro: "Two minutes." },
  { kind: "question", id: "q1", questionId: "treatment_interest" },
  { kind: "question", id: "q2", questionId: "timeline" },
  { kind: "contact", id: "c" },
  { kind: "outcome", id: "hot", band: "high", headline: "You are a great fit" },
  { kind: "outcome", id: "cold", band: "low", headline: "Worth a chat" },
];

const GRAPH: FlowGraph = {
  schemaVersion: FLOW_SCHEMA_VERSION,
  entry: "w",
  nodes: NODES,
  edges: [
    edge("w", "q1"),
    edge("q1", "q2"),
    edge("q2", "c"),
    edge("c", "hot", "high"),
    edge("c", "cold", "low"),
  ],
};

function labelsFor(graph: FlowGraph = GRAPH): Record<number, string> {
  return stepLabels(graph, stepNumbering(graph));
}

describe("the label on each bar", () => {
  it("names every ordinal the numbering hands out, and no others", () => {
    const numbering = stepNumbering(GRAPH);
    const labels = labelsFor();
    expect(Object.keys(labels).map(Number).sort((a, b) => a - b)).toEqual(
      numbering.screens.map((s) => s.stepIndex),
    );
  });

  // MUTATION: look the prompt up with questionById here. Two owners for "what does
  // this step say" is one drift away from a chart that disagrees with the funnel
  // it is charting.
  it("says exactly what screenFor says, prompt for prompt", () => {
    const labels = labelsFor();
    const first = screenFor(NODES[1]!, GRAPH, {}, 1);
    const second = screenFor(NODES[2]!, GRAPH, {}, 2);
    expect(first.kind).toBe("question"); // the welcome step is the entry, not q1
    expect(labels[0]).toBe("prompt" in first ? first.prompt : "");
    expect(labels[1]).toBe("prompt" in second ? second.prompt : "");
    // And really the bank's wording, not a re-typed copy of it.
    expect(labels[0]).toBe(questionById("treatment_interest")?.prompt);
  });

  it("names the contact screen with the runtime's own heading", () => {
    const contactScreen = screenFor(NODES[3]!, GRAPH, {}, 3);
    expect(contactScreen.kind).toBe("contact");
    expect(labelsFor()[2]).toBe("heading" in contactScreen ? contactScreen.heading : "");
  });

  // MUTATION: label the shared result ordinal with one band's headline. Every band
  // shares that slot, so "You are a great fit" would name the bar that a patient
  // who got the COLD result also lands on.
  it("names the shared result ordinal for the slot, not for one band", () => {
    const labels = labelsFor();
    expect(labels[3]).toBe(RESULT_STEP_LABEL);
    expect(labels[3]).not.toBe("You are a great fit");
  });
});

describe("the first screen carries the hero copy the patient lands on", () => {
  it("still labels the entry question with its prompt when the funnel opens on one", () => {
    const g: FlowGraph = {
      schemaVersion: FLOW_SCHEMA_VERSION,
      entry: "q1",
      nodes: [NODES[1]!, NODES[3]!],
      edges: [edge("q1", "c")],
    };
    // screenFor returns "welcome-question" for the entry node, which carries the
    // hero block AND the prompt; the label is the prompt either way.
    const screen = screenFor(NODES[1]!, g, { headline: "Hello" }, 1);
    expect(screen.kind).toBe("welcome-question");
    expect(stepLabels(g, stepNumbering(g), { headline: "Hello" })[0]).toBe(
      questionById("treatment_interest")?.prompt,
    );
  });
});

describe("a step that cannot be drawn is named loudly, never blank", () => {
  // MUTATION: fall through to "" or to `Step N` on an unknown question. That step
  // is precisely the one an owner is hunting for when the chart shows everybody
  // leaving at it, and a blank label hides it.
  it("labels a question that left the bank with the error screen's title", () => {
    const g: FlowGraph = {
      schemaVersion: FLOW_SCHEMA_VERSION,
      entry: "gone",
      nodes: [
        { kind: "question", id: "gone", questionId: "retired_question" },
        { kind: "contact", id: "c" },
      ],
      edges: [edge("gone", "c")],
    };
    const labels = stepLabels(g, stepNumbering(g));
    expect(labels[0]).toBe("This step has no question");
    expect(labels[0]).not.toBe("");
  });
});

describe("the wording lives on the server side of the bundle line", () => {
  // MUTATION: move this into step-numbering.ts "since they belong together". That
  // module is imported by the PUBLIC quiz, and screenFor imports ./quiz, which
  // carries the option weights — the practice's scoring model in a patient's
  // bundle.
  it("is imported by the guarded route and never by the public quiz", () => {
    expect(SOURCE).toContain("./flow-phone-screen");
    // The numbering's IMPORT list, not its prose: the header names
    // flow-phone-screen.ts when explaining where the welcome screen went.
    const numbering = readFileSync(join(HERE, "step-numbering.ts"), "utf8");
    const imports = [...numbering.matchAll(/^\s*import\b[\s\S]*?from\s+["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
    expect(imports).not.toContain("./step-labels");
    expect(imports).not.toContain("./flow-phone-screen");
    expect(imports).not.toContain("./quiz");
  });
});
