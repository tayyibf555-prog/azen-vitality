// The walk: what a patient sees next, and what happens when the funnel under
// them changes while they are answering it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { walkFlow, nextNode, pathTo, outcomeNodeFor, welcomeNode } from "./flow-runtime";
import { FLOW_SCHEMA_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from "./flow";
import { validateFlow } from "./flow-validate";
import { Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT } from "./quiz";

const welcome = (id = "welcome"): FlowNode => ({ id, kind: "welcome" });
const question = (questionId: string, id = `q-${questionId}`, transition?: string): FlowNode =>
  transition ? { id, kind: "question", questionId, transition } : { id, kind: "question", questionId };
const contact = (id = "contact"): FlowNode => ({ id, kind: "contact" });
const edge = (from: string, to: string, answer: string | null = null, transition?: string): FlowEdge =>
  transition ? { from, to, answer, transition } : { from, to, answer };

const Q_T = `q-${Q_TREATMENT}`;
const Q_TL = `q-${Q_TIMELINE}`;
const Q_B = `q-${Q_BUDGET}`;
const Q_L = `q-${Q_LOCATION}`;

const results = (): FlowNode[] => [
  { id: "out-high", kind: "outcome", band: "high" },
  { id: "out-medium", kind: "outcome", band: "medium" },
  { id: "out-low", kind: "outcome", band: "low" },
];
const contactEdges = (): FlowEdge[] => [
  edge("contact", "out-high", "high"),
  edge("contact", "out-medium", "medium"),
  edge("contact", "out-low", "low"),
];

/** v1: aligner answers branch to the picture question, everyone else goes straight on. */
function v1(): FlowGraph {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    entry: "welcome",
    nodes: [
      welcome(),
      question(Q_TREATMENT),
      question("smile_concern", "q-smile_concern", "A quick one about your smile."),
      question(Q_TIMELINE, Q_TL, "The question's own lead-in."),
      question(Q_BUDGET),
      question(Q_LOCATION),
      contact(),
      ...results(),
    ],
    edges: [
      edge("welcome", Q_T),
      edge(Q_T, "q-smile_concern", "invisalign"),
      edge(Q_T, Q_TL, null, "Thank you. Now, timing."),
      edge("q-smile_concern", Q_TL),
      edge(Q_TL, Q_B),
      edge(Q_B, Q_L),
      edge(Q_L, "contact"),
      ...contactEdges(),
    ],
  };
}

describe("the graph the tests are built on", () => {
  it("is a legal funnel, so nothing below is asserting against a broken one", () => {
    expect(validateFlow(v1()).ok).toBe(true);
  });
});

describe("walkFlow", () => {
  it("passes through the welcome step and asks the first question", () => {
    const walk = walkFlow(v1(), {});
    expect(walk.status).toBe("ask");
    expect(walk.status === "ask" && walk.node.questionId).toBe(Q_TREATMENT);
    expect(walk.asked).toEqual([]);
  });

  it("hands the welcome step to the caller separately, so it can be its own screen", () => {
    expect(welcomeNode(v1())?.kind).toBe("welcome");
    const noWelcome = v1();
    noWelcome.entry = Q_T;
    expect(welcomeNode(noWelcome)).toBeNull();
  });

  it("follows the edge matching the answer", () => {
    const walk = walkFlow(v1(), { [Q_TREATMENT]: "invisalign" });
    expect(walk.status === "ask" && walk.node.questionId).toBe("smile_concern");
    expect(walk.asked).toEqual([Q_TREATMENT]);
  });

  it("falls to the default edge for an answer with no edge of its own", () => {
    const walk = walkFlow(v1(), { [Q_TREATMENT]: "whitening" });
    expect(walk.status === "ask" && walk.node.questionId).toBe(Q_TIMELINE);
  });

  it("terminates at the contact step once everything on the path is answered", () => {
    const walk = walkFlow(v1(), {
      [Q_TREATMENT]: "whitening",
      [Q_TIMELINE]: "asap",
      [Q_BUDGET]: "ready",
      [Q_LOCATION]: "england",
    });
    expect(walk.status).toBe("contact");
    expect(walk.asked).toEqual([Q_TREATMENT, Q_TIMELINE, Q_BUDGET, Q_LOCATION]);
  });

  it("ignores answers to questions this funnel does not ask", () => {
    const walk = walkFlow(v1(), { [Q_TREATMENT]: "whitening", motivation: "event" });
    expect(walk.status === "ask" && walk.node.questionId).toBe(Q_TIMELINE);
  });

  it("treats a blank answer as unanswered rather than routing on it", () => {
    const walk = walkFlow(v1(), { [Q_TREATMENT]: "" });
    expect(walk.status === "ask" && walk.node.questionId).toBe(Q_TREATMENT);
  });

  it("prefers the edge's lead-in over the destination question's own", () => {
    // The timing question carries its own line AND is arrived at by an edge that
    // carries one. The edge wins: it knows what was just answered.
    const viaDefault = walkFlow(v1(), { [Q_TREATMENT]: "whitening" });
    expect(viaDefault.status === "ask" && viaDefault.transition).toBe("Thank you. Now, timing.");
  });

  it("falls back to the question's own lead-in when the edge has none", () => {
    const viaBranch = walkFlow(v1(), { [Q_TREATMENT]: "invisalign" });
    expect(viaBranch.status === "ask" && viaBranch.transition).toBe("A quick one about your smile.");
  });

  it("carries no lead-in at all rather than inventing one", () => {
    const walk = walkFlow(v1(), { [Q_TREATMENT]: "whitening", [Q_TIMELINE]: "asap" });
    expect(walk.status === "ask" && walk.node.questionId).toBe(Q_BUDGET);
    expect(walk.status === "ask" && walk.transition).toBeNull();
  });

  it("says stuck, not finished, when an answer has nowhere to go", () => {
    const g = v1();
    // Drop the default edge out of the treatment question: only aligners route.
    g.edges = g.edges.filter((e) => !(e.from === Q_T && e.answer === null));
    const walk = walkFlow(g, { [Q_TREATMENT]: "implants" });
    expect(walk.status).toBe("stuck");
    expect(walk.status === "stuck" && walk.at).toBe(Q_T);
    expect(nextNode(g, { [Q_TREATMENT]: "implants" })).toBeNull();
  });

  it("terminates on a looping graph instead of hanging the browser", () => {
    const g = v1();
    g.edges = g.edges.map((e) => (e.from === Q_L ? { ...e, to: Q_TL } : e));
    const walk = walkFlow(g, {
      [Q_TREATMENT]: "whitening",
      [Q_TIMELINE]: "asap",
      [Q_BUDGET]: "ready",
      [Q_LOCATION]: "england",
    });
    expect(walk.status).toBe("stuck");
  });

  it("says stuck when a result is reachable before the contact step", () => {
    const g = v1();
    g.edges = g.edges.map((e) => (e.from === Q_L ? { ...e, to: "out-high" } : e));
    const walk = walkFlow(g, {
      [Q_TREATMENT]: "whitening",
      [Q_TIMELINE]: "asap",
      [Q_BUDGET]: "ready",
      [Q_LOCATION]: "england",
    });
    expect(walk.status).toBe("stuck");
    expect(walk.status === "stuck" && walk.reason).toContain("out-high");
  });

  it("says stuck when the entry does not exist", () => {
    const g = v1();
    g.entry = "nowhere";
    expect(walkFlow(g, {}).status).toBe("stuck");
    expect(nextNode(g, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The edit-mid-session case. There is no server-side session: the browser holds
// its own answers and re-walks whatever graph it has. So a funnel edited under a
// live session must never leave that patient with nowhere to go.
// ---------------------------------------------------------------------------

describe("answers from one version of a funnel, walked through the next", () => {
  /** v2: a new question added mid-spine, and the picture question dropped. */
  function v2(): FlowGraph {
    return {
      schemaVersion: FLOW_SCHEMA_VERSION,
      entry: "welcome",
      nodes: [
        welcome(),
        question(Q_TREATMENT),
        question(Q_TIMELINE),
        question(Q_BUDGET),
        question("readiness"),
        question(Q_LOCATION),
        contact(),
        ...results(),
      ],
      edges: [
        edge("welcome", Q_T),
        edge(Q_T, Q_TL),
        edge(Q_TL, Q_B),
        edge(Q_B, "q-readiness"),
        edge("q-readiness", Q_L),
        edge(Q_L, "contact"),
        ...contactEdges(),
      ],
    };
  }

  const v1Answers = {
    [Q_TREATMENT]: "invisalign",
    smile_concern: "crowded", // v2 does not ask this any more
    [Q_TIMELINE]: "asap",
    [Q_BUDGET]: "ready",
    [Q_LOCATION]: "england",
  };

  it("keeps what still applies and asks only what is genuinely new", () => {
    const walk = walkFlow(v2(), v1Answers);
    expect(walk.status).toBe("ask");
    expect(walk.status === "ask" && walk.node.questionId).toBe("readiness");
    expect(walk.asked).toEqual([Q_TREATMENT, Q_TIMELINE, Q_BUDGET]);
  });

  it("finishes normally once the new question is answered, with the stale answer harmlessly along for the ride", () => {
    const walk = walkFlow(v2(), { ...v1Answers, readiness: "book_now" });
    expect(walk.status).toBe("contact");
    expect(walk.asked).toEqual([Q_TREATMENT, Q_TIMELINE, Q_BUDGET, "readiness", Q_LOCATION]);
  });

  it("never strands the session on a re-routed branch: it re-asks rather than dead-ends", () => {
    // v3 routes the aligner answer somewhere that no longer exists on the old
    // path, but keeps a default edge - the shape every valid funnel has (rule 3).
    const g = v2();
    g.nodes.push(question("smile_concern"));
    g.edges = g.edges.filter((e) => e.from !== Q_T);
    g.edges.push(edge(Q_T, "q-smile_concern", "invisalign"), edge(Q_T, Q_TL, null));
    g.edges.push(edge("q-smile_concern", Q_TL));
    expect(validateFlow(g).ok).toBe(true);
    const walk = walkFlow(g, v1Answers);
    expect(walk.status).toBe("ask");
    expect(walk.status === "ask" && walk.node.questionId).toBe("readiness");
  });
});

describe("outcomeNodeFor", () => {
  it("takes the band's own edge out of the contact step", () => {
    expect(outcomeNodeFor(v1(), "medium")?.id).toBe("out-medium");
  });

  it("takes the default edge when the band has no edge of its own", () => {
    const g = v1();
    g.edges = g.edges.filter((e) => e.answer !== "low");
    g.edges.push(edge("contact", "out-medium", null));
    expect(outcomeNodeFor(g, "low")?.id).toBe("out-medium");
  });

  it("falls back to any result carrying the band when the contact step routes nowhere", () => {
    const g = v1();
    g.edges = g.edges.filter((e) => e.from !== "contact");
    expect(outcomeNodeFor(g, "high")?.id).toBe("out-high");
  });

  it("returns null rather than a wrong result, so the caller uses the standard copy", () => {
    const g = v1();
    g.nodes = g.nodes.filter((n) => n.id !== "out-low");
    g.edges = g.edges.filter((e) => e.to !== "out-low");
    expect(outcomeNodeFor(g, "low")).toBeNull();
  });
});

describe("pathTo", () => {
  it("returns the route a patient takes to a node, entry first", () => {
    const path = pathTo(v1(), "q-smile_concern")!;
    expect(path.map((n) => n.id)).toEqual(["welcome", Q_T, "q-smile_concern"]);
  });

  it("is deterministic: the same graph gives the same route every time", () => {
    const g = v1();
    expect(pathTo(g, "contact")!.map((n) => n.id)).toEqual(pathTo(g, "contact")!.map((n) => n.id));
  });

  it("prefers the first edge in declaration order", () => {
    // The picture-question branch is declared before the default edge, so the
    // route to the timing question goes through it.
    expect(pathTo(v1(), Q_TL)!.map((n) => n.id)).toEqual(["welcome", Q_T, "q-smile_concern", Q_TL]);
  });

  it("returns null for a node nothing reaches", () => {
    const g = v1();
    g.nodes.push(question("motivation"));
    expect(pathTo(g, "q-motivation")).toBeNull();
    expect(pathTo(g, "does-not-exist")).toBeNull();
  });

  it("terminates on a looping graph", () => {
    const g = v1();
    g.edges.push(edge(Q_L, Q_T, null));
    g.nodes.push(question("motivation"));
    expect(pathTo(g, "q-motivation")).toBeNull();
    expect(pathTo(g, "contact")!.map((n) => n.id)).toContain("contact");
  });
});

// ---------------------------------------------------------------------------
// The bundle guard. Deterministic mode runs in the browser, so anything it
// imports ships to the patient. quiz.ts carries the OPTION WEIGHTS - the
// practice's scoring model - and scoring.ts carries the thresholds. Neither may
// be published. Only a source read can hold this line: vitest collects no .tsx,
// so the component that imports these cannot be tested directly.
// ---------------------------------------------------------------------------

describe("what the public walk is allowed to import", () => {
  const HERE = fileURLToPath(new URL("./", import.meta.url));
  const IMPORTS = /^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm;
  const FORBIDDEN_MODULES = ["./quiz", "./scoring", "./funnel", "@/lib/smile-assessment/quiz"];

  for (const file of ["flow.ts", "flow-runtime.ts"]) {
    it(`${file} imports nothing that carries the question weights`, () => {
      const source = readFileSync(`${HERE}${file}`, "utf8");
      const specifiers = [...source.matchAll(IMPORTS)].map((m) => m[1]!);
      for (const spec of specifiers) {
        expect(FORBIDDEN_MODULES, `${file} imports ${spec}`).not.toContain(spec);
      }
    });
  }

  it("flow.ts imports nothing at all, so the graph model can be used anywhere", () => {
    const source = readFileSync(`${HERE}flow.ts`, "utf8");
    expect([...source.matchAll(IMPORTS)].map((m) => m[1]!)).toEqual([]);
  });
});
