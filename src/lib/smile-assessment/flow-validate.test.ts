// Every rule in flow-validate.ts gets a graph that is valid EXCEPT for that one
// rule, and the test proves the rule catches it. A happy-path-only suite would
// pass against a validateFlow that returned `{ ok: true }` unconditionally, which
// is precisely the failure mode this gate exists to prevent: a funnel that looks
// fine, ships, and quietly produces zero fast-tracked leads.

import { describe, it, expect } from "vitest";
import {
  validateFlow,
  normaliseAndValidateFlow,
  describeFlowFailures,
  MAX_FLOW_QUESTION_DEPTH,
  CORE_FLOW_QUESTION_IDS,
} from "./flow-validate";
import {
  FLOW_SCHEMA_VERSION,
  normaliseFlow,
  type FlowBand,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "./flow";
import { Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT } from "./quiz";

// ---------------------------------------------------------------------------
// Builders. Terse on purpose: every test below should read as "the base funnel,
// but with X broken".
// ---------------------------------------------------------------------------

const welcome = (id = "welcome"): FlowNode => ({ id, kind: "welcome" });
const question = (questionId: string, id = `q-${questionId}`): FlowNode => ({
  id,
  kind: "question",
  questionId,
});
const contact = (id = "contact"): FlowNode => ({ id, kind: "contact" });
const outcome = (band: FlowBand, id = `out-${band}`): FlowNode => ({ id, kind: "outcome", band });
const edge = (from: string, to: string, answer: string | null = null): FlowEdge => ({ from, to, answer });

const Q_T = `q-${Q_TREATMENT}`;
const Q_TL = `q-${Q_TIMELINE}`;
const Q_B = `q-${Q_BUDGET}`;
const Q_L = `q-${Q_LOCATION}`;

const contactEdges = (): FlowEdge[] => [
  edge("contact", "out-high", "high"),
  edge("contact", "out-medium", "medium"),
  edge("contact", "out-low", "low"),
];
const results = (): FlowNode[] => [outcome("high"), outcome("medium"), outcome("low")];

/** A valid, minimal funnel: welcome, the core trio, region, contact, three results. */
function base(): FlowGraph {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    entry: "welcome",
    nodes: [
      welcome(),
      question(Q_TREATMENT),
      question(Q_TIMELINE),
      question(Q_BUDGET),
      question(Q_LOCATION),
      contact(),
      ...results(),
    ],
    edges: [
      edge("welcome", Q_T),
      edge(Q_T, Q_TL),
      edge(Q_TL, Q_B),
      edge(Q_B, Q_L),
      edge(Q_L, "contact"),
      ...contactEdges(),
    ],
  };
}

const codes = (g: FlowGraph): string[] => validateFlow(g).failures.map((f) => f.code);
const rulesHit = (g: FlowGraph): number[] => [...new Set(validateFlow(g).failures.map((f) => f.rule))];

describe("the base funnel", () => {
  it("passes every rule", () => {
    const result = validateFlow(base());
    expect(describeFlowFailures(result.failures)).toBe("");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RULE 1 - structure.
// ---------------------------------------------------------------------------

describe("rule 1: structure", () => {
  it("rejects a schemaVersion from another era", () => {
    const g = base();
    g.schemaVersion = FLOW_SCHEMA_VERSION + 1;
    expect(codes(g)).toContain("schema_version");
  });

  it("rejects an entry that is not one of the nodes", () => {
    const g = base();
    g.entry = "nowhere";
    expect(codes(g)).toContain("entry_missing");
    expect(validateFlow(g).ok).toBe(false);
  });

  it("rejects two nodes sharing an id", () => {
    const g = base();
    g.nodes.push(question(Q_TIMELINE, Q_T));
    expect(codes(g)).toContain("duplicate_node_id");
  });

  it("rejects an edge pointing at a node that does not exist", () => {
    const g = base();
    g.edges.push(edge(Q_L, "ghost"));
    expect(codes(g)).toContain("edge_unknown_to");
  });
});

// ---------------------------------------------------------------------------
// RULE 2 - only bank questions, only real option values.
// ---------------------------------------------------------------------------

describe("rule 2: bank references", () => {
  it("rejects a question id that is not in the bank", () => {
    const g = base();
    g.nodes = g.nodes.map((n) => (n.id === Q_TL ? question("do_you_like_us", Q_TL) : n));
    expect(codes(g)).toContain("unknown_question");
  });

  it("rejects an edge answer that is not an option of its question", () => {
    const g = base();
    g.edges = g.edges.map((e) => (e.from === Q_T ? { ...e, answer: "moon_base" } : e));
    expect(codes(g)).toContain("edge_answer_not_an_option");
  });

  it("rejects a band that is not a band on an edge out of the contact step", () => {
    const g = base();
    g.edges = g.edges.map((e) => (e.answer === "medium" ? { ...e, answer: "middling" } : e));
    expect(codes(g)).toContain("edge_band_invalid");
  });

  it("rejects an answer on an edge out of the welcome step", () => {
    const g = base();
    g.edges = g.edges.map((e) => (e.from === "welcome" ? { ...e, answer: "asap" } : e));
    expect(codes(g)).toContain("edge_answer_on_welcome");
  });
});

// ---------------------------------------------------------------------------
// RULE 3 - every answer has somewhere to go.
// ---------------------------------------------------------------------------

describe("rule 3: answer coverage", () => {
  it("rejects an option with no edge and no default edge", () => {
    const g = base();
    // Route only two of the seven treatment answers, and remove the default.
    g.edges = g.edges.filter((e) => e.from !== Q_T);
    g.edges.push(edge(Q_T, Q_TL, "invisalign"), edge(Q_T, Q_TL, "implants"));
    const failures = validateFlow(g).failures.filter((f) => f.code === "option_uncovered");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.map((f) => f.message).join(" ")).toContain("whitening");
  });

  it("accepts partial routing when a default edge catches the rest", () => {
    const g = base();
    g.edges = g.edges.filter((e) => e.from !== Q_T);
    g.edges.push(edge(Q_T, Q_TL, "invisalign"), edge(Q_T, Q_TL, null));
    expect(codes(g)).not.toContain("option_uncovered");
    expect(validateFlow(g).ok).toBe(true);
  });

  it("rejects two edges claiming the same answer", () => {
    const g = base();
    g.edges.push(edge(Q_T, "contact", null));
    expect(codes(g)).toContain("duplicate_edge_answer");
  });

  it("rejects a contact step with no route out for one of the bands", () => {
    const g = base();
    g.edges = g.edges.filter((e) => e.answer !== "low");
    expect(codes(g)).toContain("band_uncovered");
  });
});

// ---------------------------------------------------------------------------
// RULE 4 - acyclic, and no longer than the adaptive funnel plus slack.
// ---------------------------------------------------------------------------

describe("rule 4: shape and length", () => {
  it("rejects a loop", () => {
    const g = base();
    g.edges.push(edge(Q_L, Q_TL));
    const result = validateFlow(g);
    expect(result.failures.map((f) => f.code)).toContain("cycle");
    expect(result.ok).toBe(false);
  });

  it("says out loud that a loop blocks the path rules rather than quietly passing them", () => {
    const g = base();
    g.edges.push(edge(Q_L, Q_TL));
    expect(codes(g)).toContain("cycle_blocks_checks");
  });

  it(`rejects a path asking more than ${MAX_FLOW_QUESTION_DEPTH} questions`, () => {
    // Nine questions on one path, and legal in every other respect: the aligner
    // branch is only reachable on the aligner answer, nothing repeats.
    const g: FlowGraph = {
      schemaVersion: FLOW_SCHEMA_VERSION,
      entry: "welcome",
      nodes: [
        welcome(),
        question(Q_TREATMENT),
        question("smile_concern"),
        question("align_detail"),
        question(Q_TIMELINE),
        question(Q_BUDGET),
        question("readiness"),
        question("motivation"),
        question("experience"),
        question(Q_LOCATION),
        contact(),
        ...results(),
      ],
      edges: [
        edge("welcome", Q_T),
        edge(Q_T, "q-smile_concern", "invisalign"),
        edge(Q_T, Q_TL),
        edge("q-smile_concern", "q-align_detail"),
        edge("q-align_detail", Q_TL),
        edge(Q_TL, Q_B),
        edge(Q_B, "q-readiness"),
        edge("q-readiness", "q-motivation"),
        edge("q-motivation", "q-experience"),
        edge("q-experience", Q_L),
        edge(Q_L, "contact"),
        ...contactEdges(),
      ],
    };
    expect(codes(g)).toContain("too_deep");
    // ...and nothing else: this graph is otherwise entirely legal.
    expect(rulesHit(g)).toEqual([4]);
  });
});

// ---------------------------------------------------------------------------
// RULE 5 - nothing stranded.
// ---------------------------------------------------------------------------

describe("rule 5: reachability", () => {
  it("rejects a node nothing points at", () => {
    const g = base();
    g.nodes.push(question("motivation"));
    expect(codes(g)).toContain("orphan");
  });

  it("does not let an unreachable result step satisfy a band", () => {
    const g = base();
    g.edges = g.edges.filter((e) => e.to !== "out-low");
    g.edges.push(edge("contact", "out-medium", "low"));
    const c = codes(g);
    expect(c).toContain("orphan");
    expect(c).toContain("band_missing");
  });
});

// ---------------------------------------------------------------------------
// RULE 6 - one contact step, and it comes first.
// ---------------------------------------------------------------------------

describe("rule 6: the contact step", () => {
  it("rejects a funnel with no contact step", () => {
    const g = base();
    g.nodes = g.nodes.filter((n) => n.id !== "contact");
    g.nodes.push(welcome("stand-in"));
    g.edges = g.edges.map((e) => (e.to === "contact" ? { ...e, to: "stand-in" } : e));
    g.edges = g.edges.filter((e) => e.from !== "contact");
    g.edges.push(edge("stand-in", "out-high"));
    const c = codes(g);
    expect(c).toContain("contact_count");
  });

  it("rejects two contact steps", () => {
    const g = base();
    g.nodes.push(contact("contact-2"));
    g.edges = g.edges.map((e) => (e.from === Q_L ? { ...e, to: "contact-2" } : e));
    g.edges.push(edge("contact-2", "contact"));
    expect(codes(g)).toContain("contact_count");
  });

  it("rejects a result a patient can reach without leaving their details", () => {
    const g = base();
    // A short-circuit from the region question straight to the low result.
    g.edges = g.edges.filter((e) => e.from !== Q_L);
    g.edges.push(edge(Q_L, "contact", "england"), edge(Q_L, "out-low", null));
    expect(codes(g)).toContain("outcome_before_contact");
  });
});

// ---------------------------------------------------------------------------
// RULE 7 - every ending is a result, and all three exist.
// ---------------------------------------------------------------------------

describe("rule 7: endings", () => {
  it("rejects a missing band", () => {
    const g = base();
    g.nodes = g.nodes.filter((n) => n.id !== "out-medium");
    g.edges = g.edges.filter((e) => e.to !== "out-medium");
    expect(codes(g)).toContain("band_missing");
  });

  it("rejects a dead end that is not a result", () => {
    const g = base();
    g.nodes.push(question("motivation"));
    g.edges = g.edges.filter((e) => e.from !== Q_L);
    g.edges.push(edge(Q_L, "contact", "england"), edge(Q_L, "q-motivation", null));
    expect(codes(g)).toContain("terminal_not_outcome");
  });

  it("rejects a result that carries on somewhere", () => {
    const g = base();
    g.edges.push(edge("out-high", "contact"));
    expect(codes(g)).toContain("outcome_not_terminal");
  });
});

// ---------------------------------------------------------------------------
// RULE 8 - never ask the same thing twice.
// ---------------------------------------------------------------------------

describe("rule 8: no repeated question on a path", () => {
  it("rejects the same question asked twice on one path", () => {
    const g = base();
    g.nodes.push(question(Q_TIMELINE, "q-timeline-again"));
    g.edges = g.edges.filter((e) => e.from !== Q_B);
    g.edges.push(edge(Q_B, "q-timeline-again"), edge("q-timeline-again", Q_L));
    expect(codes(g)).toContain("question_repeated");
  });

  it("rejects a repeat that only happens on ONE of the paths into a node", () => {
    // The version a "does every path repeat it?" check would wave through: one
    // branch asks motivation, both branches merge, then everyone is asked it
    // again. Only the patients who took the first branch see it twice.
    const g = base();
    g.nodes.push(question("motivation", "q-motivation-a"), question("motivation", "q-motivation-b"));
    g.edges = g.edges.filter((e) => e.from !== Q_B && e.from !== Q_L);
    g.edges.push(
      edge(Q_B, "q-motivation-a", "ready"),
      edge(Q_B, Q_L, null),
      edge("q-motivation-a", Q_L),
      edge(Q_L, "q-motivation-b"),
      edge("q-motivation-b", "contact"),
    );
    const failures = validateFlow(g).failures.filter((f) => f.code === "question_repeated");
    expect(failures.map((f) => f.where)).toEqual(["q-motivation-b"]);
  });

  it("allows the same question on two different branches", () => {
    const g = base();
    // Two mutually exclusive branches, each asking the region question once.
    g.nodes.push(question(Q_LOCATION, "q-location-b"));
    g.edges = g.edges.filter((e) => e.from !== Q_B);
    g.edges.push(
      edge(Q_B, Q_L, "ready"),
      edge(Q_B, "q-location-b", null),
      edge("q-location-b", "contact"),
    );
    expect(codes(g)).not.toContain("question_repeated");
    expect(validateFlow(g).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RULE 9 - a treatment-specific question only on its own branch.
// ---------------------------------------------------------------------------

describe("rule 9: appliesTo coherence", () => {
  it("rejects the implant question on the aligner branch", () => {
    const g = base();
    g.nodes.push(question("implant_scope"));
    g.edges = g.edges.filter((e) => e.from !== Q_T);
    g.edges.push(edge(Q_T, "q-implant_scope", "invisalign"), edge(Q_T, Q_TL, null));
    g.edges.push(edge("q-implant_scope", Q_TL));
    const failures = validateFlow(g).failures.filter((f) => f.code === "applies_to_violation");
    expect(failures.length).toBe(1);
    expect(failures[0]!.message).toContain("invisalign");
  });

  it("rejects a treatment-specific question the default edge can also reach", () => {
    const g = base();
    g.nodes.push(question("implant_scope"));
    // The default edge carries every unrouted treatment answer here too.
    g.edges = g.edges.filter((e) => e.from !== Q_T);
    g.edges.push(edge(Q_T, "q-implant_scope", null), edge("q-implant_scope", Q_TL));
    expect(codes(g)).toContain("applies_to_violation");
  });

  it("accepts it on its own branch", () => {
    const g = base();
    g.nodes.push(question("implant_scope"));
    g.edges = g.edges.filter((e) => e.from !== Q_T);
    g.edges.push(
      edge(Q_T, "q-implant_scope", "implants"),
      edge(Q_T, Q_TL, null),
      edge("q-implant_scope", Q_TL),
    );
    expect(validateFlow(g).ok).toBe(true);
  });

  it("rejects it when only SOME paths have asked the treatment question first", () => {
    // The leak a "was it asked anywhere?" check would wave through: one branch
    // asks about treatment and routes implant enquiries onward, the other walks
    // straight into the implant question having asked nothing.
    const g: FlowGraph = {
      schemaVersion: FLOW_SCHEMA_VERSION,
      entry: "welcome",
      nodes: [
        welcome(),
        question(Q_TIMELINE),
        question(Q_TREATMENT),
        question("implant_scope"),
        question(Q_BUDGET),
        question(Q_LOCATION),
        contact(),
        ...results(),
      ],
      edges: [
        edge("welcome", Q_TL),
        edge(Q_TL, Q_T, "asap"),
        edge(Q_TL, "q-implant_scope", null),
        edge(Q_T, "q-implant_scope", "implants"),
        edge(Q_T, Q_B, null),
        edge("q-implant_scope", Q_B),
        edge(Q_B, Q_L),
        edge(Q_L, "contact"),
        ...contactEdges(),
      ],
    };
    expect(codes(g)).toContain("applies_to_unanswered");
  });

  it("rejects it when the treatment question has not been asked at all", () => {
    const g: FlowGraph = {
      schemaVersion: FLOW_SCHEMA_VERSION,
      entry: "welcome",
      nodes: [
        welcome(),
        question("implant_scope"),
        question(Q_TREATMENT),
        question(Q_TIMELINE),
        question(Q_BUDGET),
        question(Q_LOCATION),
        contact(),
        ...results(),
      ],
      edges: [
        edge("welcome", "q-implant_scope"),
        edge("q-implant_scope", Q_T),
        edge(Q_T, Q_TL),
        edge(Q_TL, Q_B),
        edge(Q_B, Q_L),
        edge(Q_L, "contact"),
        ...contactEdges(),
      ],
    };
    expect(codes(g)).toContain("applies_to_unanswered");
  });
});

// ---------------------------------------------------------------------------
// RULE 10 - THE ONE THAT COSTS MONEY SILENTLY.
// ---------------------------------------------------------------------------

describe("rule 10: core coverage", () => {
  for (const core of CORE_FLOW_QUESTION_IDS) {
    it(`rejects a funnel that never asks "${core}"`, () => {
      const g = base();
      const id = `q-${core}`;
      const before = g.edges.find((e) => e.to === id)!;
      const after = g.edges.find((e) => e.from === id)!;
      g.nodes = g.nodes.filter((n) => n.id !== id);
      g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
      g.edges.push(edge(before.from, after.to));
      const failures = validateFlow(g).failures.filter((f) => f.code === "core_missing");
      expect(failures.map((f) => f.message).join(" ")).toContain(core);
    });
  }

  it("rejects a BRANCH that skips the funding question, even when another branch asks it", () => {
    // The nastiest version: the funnel looks complete on the happy path, and one
    // side route quietly caps every lead that takes it at medium.
    const g = base();
    g.edges = g.edges.filter((e) => e.from !== Q_TL);
    g.edges.push(edge(Q_TL, Q_B, "asap"), edge(Q_TL, Q_L, null));
    const failures = validateFlow(g).failures.filter((f) => f.code === "core_missing");
    expect(failures.length).toBe(1);
    expect(failures[0]!.message).toContain(Q_BUDGET);
  });

  it("explains the consequence, because the symptom is invisible", () => {
    const g = base();
    g.edges = g.edges.filter((e) => e.from !== Q_TL);
    g.edges.push(edge(Q_TL, Q_B, "asap"), edge(Q_TL, Q_L, null));
    const message = validateFlow(g).failures.find((f) => f.code === "core_missing")!.message;
    expect(message).toMatch(/medium/);
  });
});

// ---------------------------------------------------------------------------
// RULE 11 - region.
// ---------------------------------------------------------------------------

describe("rule 11: region coverage", () => {
  it("rejects a funnel that never asks where they are based", () => {
    const g = base();
    g.nodes = g.nodes.filter((n) => n.id !== Q_L);
    g.edges = g.edges.filter((e) => e.from !== Q_L && e.to !== Q_L);
    g.edges.push(edge(Q_B, "contact"));
    expect(codes(g)).toContain("location_missing");
  });

  it("rejects a branch that skips the region question", () => {
    const g = base();
    g.edges = g.edges.filter((e) => e.from !== Q_B);
    g.edges.push(edge(Q_B, Q_L, "ready"), edge(Q_B, "contact", null));
    expect(codes(g)).toContain("location_missing");
  });
});

// ---------------------------------------------------------------------------
// The doctrine: every failure at once.
// ---------------------------------------------------------------------------

describe("reporting", () => {
  it("returns every failure at once, not just the first", () => {
    const g = base();
    g.schemaVersion = 99; // rule 1
    g.nodes = g.nodes.filter((n) => n.id !== Q_B); // rules 10 + 5-ish
    g.edges = g.edges.filter((e) => e.from !== Q_B && e.to !== Q_B);
    g.edges.push(edge(Q_TL, Q_L));
    g.nodes.push(question("implant_scope")); // rule 5
    g.edges = g.edges.filter((e) => e.answer !== "low"); // rules 3 + 5 + 7

    const hit = rulesHit(g).sort((a, b) => a - b);
    expect(hit).toContain(1);
    expect(hit).toContain(3);
    expect(hit).toContain(5);
    expect(hit).toContain(7);
    expect(hit).toContain(10);
    expect(hit.length).toBeGreaterThanOrEqual(5);
  });

  it("renders the failures as a list a model can be asked to fix", () => {
    const g = base();
    g.entry = "nowhere";
    const text = describeFlowFailures(validateFlow(g).failures);
    expect(text).toContain("[rule 1: entry_missing]");
    expect(text.split("\n").length).toBe(validateFlow(g).failures.length);
  });
});

// ---------------------------------------------------------------------------
// Coercion: the shape gate in front of the rules.
// ---------------------------------------------------------------------------

describe("normaliseFlow", () => {
  it("round-trips a good graph and returns a fresh object", () => {
    const g = base();
    const out = normaliseFlow(JSON.parse(JSON.stringify(g)));
    expect(out).toEqual(g);
    expect(out).not.toBe(g);
  });

  it("refuses rather than repairing: one malformed node fails the whole graph", () => {
    const g = base() as unknown as { nodes: unknown[] };
    g.nodes[2] = { id: "q-broken", kind: "question" }; // no questionId
    expect(normaliseFlow(g)).toBeNull();
  });

  it("refuses an unknown node kind (a newer schema must not be half-read)", () => {
    const g = base() as unknown as { nodes: unknown[] };
    g.nodes.push({ id: "video", kind: "video", url: "/x.mp4" });
    expect(normaliseFlow(g)).toBeNull();
  });

  it("refuses copy over the length cap", () => {
    const g = base();
    g.nodes = g.nodes.map((n) => (n.id === Q_TL ? { ...n, transition: "x".repeat(500) } : n));
    expect(normaliseFlow(JSON.parse(JSON.stringify(g)))).toBeNull();
  });

  it("treats blank authored copy as absent, never as an empty line", () => {
    const g = base();
    g.nodes = g.nodes.map((n) => (n.id === Q_TL ? { ...n, transition: "   " } : n));
    const out = normaliseFlow(JSON.parse(JSON.stringify(g)))!;
    const node = out.nodes.find((n) => n.id === Q_TL)!;
    expect("transition" in node).toBe(false);
  });

  it("reads a missing edge answer as the default route", () => {
    const raw = JSON.parse(JSON.stringify(base())) as { edges: Record<string, unknown>[] };
    for (const e of raw.edges) if (e.answer === null) delete e.answer;
    const out = normaliseFlow(raw)!;
    expect(out.edges.filter((e) => e.answer === null).length).toBe(5);
  });

  it("leaves the schema version to rule 1 rather than swallowing it", () => {
    const raw = { ...base(), schemaVersion: 99 };
    const graph = normaliseFlow(JSON.parse(JSON.stringify(raw)));
    expect(graph).not.toBeNull();
    expect(validateFlow(graph!).failures.map((f) => f.code)).toContain("schema_version");
  });

  it("normaliseAndValidateFlow reports an unreadable blob as rule 0 and yields no graph", () => {
    const { graph, result } = normaliseAndValidateFlow({ nope: true });
    expect(graph).toBeNull();
    expect(result.failures.map((f) => f.rule)).toEqual([0]);
  });

  it("normaliseAndValidateFlow yields no graph when the rules fail", () => {
    const broken = base();
    broken.entry = "nowhere";
    const { graph, result } = normaliseAndValidateFlow(JSON.parse(JSON.stringify(broken)));
    expect(graph).toBeNull();
    expect(result.ok).toBe(false);
  });

  it("normaliseAndValidateFlow yields the graph when everything holds", () => {
    const { graph, result } = normaliseAndValidateFlow(JSON.parse(JSON.stringify(base())));
    expect(result.ok).toBe(true);
    expect(graph?.entry).toBe("welcome");
  });
});
