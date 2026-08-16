// THE NUMBERING DECISION, held to. Everything a bar on the drop-off chart means
// is decided in step-numbering.ts, and every property below is one an owner would
// only discover was wrong by mis-reading their own funnel for a month.
//
// The four that matter most, and what goes wrong without each:
//   1. a welcome step is NOT a screen        -> a permanently-empty first bar,
//                                               exactly where the biggest number
//                                               belongs.
//   2. shared endings sort LAST              -> the contact screen drawn in the
//                                               middle of the funnel.
//   3. every result step shares one ordinal  -> completionPct reports the share of
//                                               visitors who got the LOW result.
//   4. ties break on DECLARATION order       -> re-tuning the canvas's crossing
//                                               heuristic silently re-maps every
//                                               stored ordinal at the same version.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { FLOW_SCHEMA_VERSION, type FlowGraph, type FlowNode, type FlowEdge } from "./flow";
import { MAX_STEP_INDEX } from "./step-events";
import { walkFlow } from "./flow-runtime";
import { stepNumbering, stepIndexOf } from "./step-numbering";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "step-numbering.ts"), "utf8");

/* ---------------------------------------------------------------------------
 * Fixtures. Built by hand rather than from a template, so each graph is exactly
 * the shape the property under test is about.
 * ------------------------------------------------------------------------- */

function graph(nodes: FlowNode[], edges: FlowEdge[], entry = nodes[0]!.id): FlowGraph {
  return { schemaVersion: FLOW_SCHEMA_VERSION, entry, nodes, edges };
}

const welcome = (id: string): FlowNode => ({ kind: "welcome", id, headline: "Hello" });
const question = (id: string, questionId: string): FlowNode => ({
  kind: "question",
  id,
  questionId,
});
const contact = (id: string): FlowNode => ({ kind: "contact", id });
const outcome = (id: string, band: "high" | "medium" | "low"): FlowNode => ({
  kind: "outcome",
  id,
  band,
  headline: `${band} result`,
});
const edge = (from: string, to: string, answer: string | null = null): FlowEdge => ({
  from,
  to,
  answer,
});

/** welcome -> q1 -> q2 -> contact -> three results. The ordinary funnel. */
function linearFunnel(): FlowGraph {
  return graph(
    [
      welcome("w"),
      question("q1", "treatment_interest"),
      question("q2", "timeline"),
      contact("c"),
      outcome("hot", "high"),
      outcome("warm", "medium"),
      outcome("cold", "low"),
    ],
    [
      edge("w", "q1"),
      edge("q1", "q2"),
      edge("q2", "c"),
      edge("c", "hot", "high"),
      edge("c", "warm", "medium"),
      edge("c", "cold", "low"),
    ],
  );
}

/* ---------------------------------------------------------------------------
 * 1. The ordinary funnel.
 * ------------------------------------------------------------------------- */

describe("the screens of a straight funnel", () => {
  it("numbers question, question, contact, result — and nothing else", () => {
    const n = stepNumbering(linearFunnel());
    expect(n.stepCount).toBe(4);
    expect(n.screens.map((s) => [s.stepIndex, s.kind])).toEqual([
      [0, "question"],
      [1, "question"],
      [2, "contact"],
      [3, "outcome"],
    ]);
  });

  // MUTATION: give the welcome step its own ordinal. There is no start button in
  // this runtime — the hero copy renders ABOVE the first question's prompt — so a
  // welcome ordinal is a bar nobody can ever reach, drawn first.
  it("gives a welcome step no ordinal at all, because it is not a screen", () => {
    const n = stepNumbering(linearFunnel());
    expect(stepIndexOf(n, "w")).toBeNull();
    expect(stepIndexOf(n, "q1")).toBe(0);
  });

  it("puts the contact step and the result step where the runtime does", () => {
    const n = stepNumbering(linearFunnel());
    expect(n.contactStep).toBe(2);
    expect(n.outcomeStep).toBe(3);
    expect(n.outcomeStep).toBe(n.stepCount - 1);
  });
});

/* ---------------------------------------------------------------------------
 * 2. The completion decision.
 * ------------------------------------------------------------------------- */

describe("every result step shares the last ordinal", () => {
  // MUTATION: one ordinal per band. aggregateStepEvents reads completionPct off
  // the LAST step, so three result ordinals make the reported completion rate the
  // share of visitors who got the LOW result — a plausible-looking wrong number.
  it("maps high, medium and low to one number", () => {
    const n = stepNumbering(linearFunnel());
    expect(stepIndexOf(n, "hot")).toBe(3);
    expect(stepIndexOf(n, "warm")).toBe(3);
    expect(stepIndexOf(n, "cold")).toBe(3);
  });

  it("counts the collapsed result as ONE screen in stepCount", () => {
    const n = stepNumbering(linearFunnel());
    // 7 nodes, 4 screens: the welcome is not one and the three results are one.
    expect(n.stepCount).toBe(4);
  });

  it("reports no result ordinal for a funnel that has none", () => {
    const n = stepNumbering(
      graph(
        [question("q1", "treatment_interest"), contact("c")],
        [edge("q1", "c")],
      ),
    );
    expect(n.outcomeStep).toBeNull();
    expect(n.stepCount).toBe(2);
  });
});

/* ---------------------------------------------------------------------------
 * 3. Branching: depth, not breadth.
 * ------------------------------------------------------------------------- */

describe("a branching funnel numbers by longest path", () => {
  // MUTATION: order breadth-first. The short branch reaches the contact step at
  // depth 1, so a BFS numbering draws the contact screen BEFORE the questions on
  // the long branch — a funnel chart whose ending is in the middle.
  it("keeps the shared ending last even when a branch skips straight to it", () => {
    const g = graph(
      [
        question("q1", "treatment_interest"),
        contact("c"),
        question("q2", "timeline"),
        question("q3", "budget_readiness"),
        outcome("res", "high"),
      ],
      [
        edge("q1", "c", "unsure"), // the short branch, declared FIRST
        edge("q1", "q2"),
        edge("q2", "q3"),
        edge("q3", "c"),
        edge("c", "res"),
      ],
    );
    const n = stepNumbering(g);
    expect(n.screens.map((s) => s.nodeId)).toEqual(["q1", "q2", "q3", "c", "res"]);
    expect(n.contactStep).toBe(3);
  });

  // MUTATION: break the tie by anything the CANVAS decides (barycentre). That is a
  // crossing-reduction heuristic tuned for looks; re-tuning it would re-map every
  // stored ordinal for the same flow version onto a different screen.
  it("breaks a same-depth tie on declaration order, not on the picture", () => {
    const g = graph(
      [
        question("root", "treatment_interest"),
        question("second", "budget_readiness"),
        question("first", "timeline"),
        contact("c"),
      ],
      [
        edge("root", "first", "implants"),
        edge("root", "second"),
        edge("first", "c"),
        edge("second", "c"),
      ],
    );
    const n = stepNumbering(g);
    // "second" is declared before "first" and both sit at depth 1.
    expect(n.screens.map((s) => s.nodeId)).toEqual(["root", "second", "first", "c"]);
  });

  it("is byte-identical on two runs of the same graph", () => {
    const g = linearFunnel();
    const a = stepNumbering(g);
    const b = stepNumbering(g);
    expect([...a.ordinals.entries()]).toEqual([...b.ordinals.entries()]);
    expect(a.screens).toEqual(b.screens);
  });

  it("never mutates the graph it was given", () => {
    const g = linearFunnel();
    const before = JSON.stringify(g);
    stepNumbering(g);
    expect(JSON.stringify(g)).toBe(before);
  });
});

/* ---------------------------------------------------------------------------
 * 4. Graphs that should never exist, and must not hang or invent.
 * ------------------------------------------------------------------------- */

describe("a graph that never validated", () => {
  // MUTATION: number every node in graph.nodes. An unreachable step is a step no
  // patient can see, and giving it an ordinal both lengthens the funnel and adds a
  // bar that is permanently zero.
  it("gives an unreachable step no ordinal and does not lengthen the funnel", () => {
    const g = graph(
      [
        question("q1", "treatment_interest"),
        contact("c"),
        question("orphan", "timeline"),
      ],
      [edge("q1", "c")],
    );
    const n = stepNumbering(g);
    expect(stepIndexOf(n, "orphan")).toBeNull();
    expect(n.stepCount).toBe(2);
  });

  // MUTATION: assume acyclic and recurse. Rule 4a forbids a loop, but a draft can
  // hold one and this is called on the stored flow — a hang here is a hung builder.
  it("terminates on a cycle and still numbers every reachable screen", () => {
    const g = graph(
      [
        question("q1", "treatment_interest"),
        question("q2", "timeline"),
        question("q3", "budget_readiness"),
        contact("c"),
      ],
      [edge("q1", "q2"), edge("q2", "q3"), edge("q3", "q2"), edge("q2", "c")],
    );
    const n = stepNumbering(g);
    expect(n.stepCount).toBe(4);
    expect(stepIndexOf(n, "q1")).toBe(0);
    expect(new Set(n.screens.map((s) => s.nodeId))).toEqual(new Set(["q1", "q2", "q3", "c"]));
  });

  it("answers an empty numbering for an entry that is not a node", () => {
    const g = graph([question("q1", "treatment_interest")], [], "nowhere");
    const n = stepNumbering(g);
    expect(n.stepCount).toBe(0);
    expect(n.screens).toEqual([]);
    expect(n.contactStep).toBeNull();
  });

  // MUTATION: hand out ordinals past MAX_STEP_INDEX. The endpoint drops them at the
  // door (isValidStepIndex), so the chart would draw bars for screens whose events
  // can never arrive — a tail of empty steps that looks like total abandonment.
  it("stops at the ordinal the public endpoint would refuse", () => {
    const many = Array.from({ length: MAX_STEP_INDEX + 10 }, (_, i) =>
      question(`q${i}`, "treatment_interest"),
    );
    const links = many.slice(1).map((n, i) => edge(many[i]!.id, n.id));
    const n = stepNumbering(graph(many, links));
    expect(n.stepCount).toBe(MAX_STEP_INDEX + 1);
    expect(stepIndexOf(n, `q${MAX_STEP_INDEX}`)).toBe(MAX_STEP_INDEX);
    expect(stepIndexOf(n, `q${MAX_STEP_INDEX + 1}`)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * 5. The bundle boundary. This module is imported by the public quiz.
 * ------------------------------------------------------------------------- */

describe("the numbering is safe to pull into the public quiz", () => {
  // MUTATION: import ./quiz for a prompt, or flow-layout for its column order. The
  // first puts the practice's scoring WEIGHTS in a patient's bundle; the second
  // ships the whole canvas geometry engine to a phone and ties the numbering to
  // layout metrics.
  it("imports only flow.ts and the step-event rules", () => {
    const imports = [...SOURCE.matchAll(/^\s*import\b[\s\S]*?from\s+["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual(["./flow", "./step-events"]);
  });

  it("names nothing server-only and no React", () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const banned of ["serviceClient", "server-only", "react", "process.env"]) {
      expect(code, `found ${banned}`).not.toContain(banned);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 6. THE SEAM. What a real session emits, walked with the very function the
 *    runtime walks with — because the numbering is only worth anything if the
 *    ordinals the browser posts are the ordinals the chart draws.
 * ------------------------------------------------------------------------- */

/**
 * One session, screen by screen: walkFlow decides what comes next (exactly as
 * DeterministicAssessmentQuiz does), and each screen is recorded under the ordinal
 * the numbering gives its node. The contact and result screens are appended the
 * way the component's effect appends them.
 */
function sessionOrdinals(g: FlowGraph, answer: (questionId: string) => string): number[] {
  const numbering = stepNumbering(g);
  const answers: Record<string, string> = {};
  const emitted: number[] = [];
  for (let hop = 0; hop < 32; hop++) {
    const walk = walkFlow(g, answers);
    if (walk.status === "stuck") throw new Error(`stuck: ${walk.reason}`);
    if (walk.status === "contact") {
      if (numbering.contactStep !== null) emitted.push(numbering.contactStep);
      if (numbering.outcomeStep !== null) emitted.push(numbering.outcomeStep);
      return emitted;
    }
    const ordinal = stepIndexOf(numbering, walk.node.id);
    if (ordinal !== null) emitted.push(ordinal);
    answers[walk.node.questionId] = answer(walk.node.questionId);
  }
  throw new Error("the walk did not settle");
}

describe("the ordinals a real session emits", () => {
  it("walks a straight funnel as 0, 1, 2, 3 — every screen, in order, once", () => {
    expect(sessionOrdinals(linearFunnel(), () => "anything")).toEqual([0, 1, 2, 3]);
  });

  // MUTATION: number by the SESSION's depth instead (walkFlow's `asked`.length).
  // Then this session emits 0,1,2 and so does the long branch's, and "step 1" is a
  // different question for two patients — the one thing a per-screen chart must not
  // be. With a per-SCREEN numbering the short branch legitimately SKIPS ordinals,
  // and the skipped ones draw as empty bars because the route passes stepCount.
  it("skips the ordinals a branch does not visit, rather than renumbering them", () => {
    const g = graph(
      [
        question("q1", "treatment_interest"),
        question("q2", "timeline"),
        question("q3", "budget_readiness"),
        contact("c"),
        outcome("res", "high"),
      ],
      [
        edge("q1", "c", "unsure"), // the short way out
        edge("q1", "q2"),
        edge("q2", "q3"),
        edge("q3", "c"),
        edge("c", "res"),
      ],
    );
    const numbering = stepNumbering(g);
    expect(numbering.screens.map((s) => s.nodeId)).toEqual(["q1", "q2", "q3", "c", "res"]);

    // The short branch: first screen, then straight to contact and the result.
    expect(sessionOrdinals(g, () => "unsure")).toEqual([0, 3, 4]);
    // The long branch: every screen.
    expect(sessionOrdinals(g, () => "implants")).toEqual([0, 1, 2, 3, 4]);
  });

  it("emits nothing at all for a welcome-led funnel's welcome step", () => {
    const emitted = sessionOrdinals(linearFunnel(), () => "x");
    // Four screens for seven nodes: the welcome is skipped, the results collapse.
    expect(emitted).toHaveLength(4);
    expect(emitted[0]).toBe(0);
  });
});
