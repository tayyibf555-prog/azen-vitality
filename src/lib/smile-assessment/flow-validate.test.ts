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
  FLOW_LIMITS,
  FLOW_SCHEMA_VERSION,
  normaliseFlow,
  type FlowBand,
  type FlowBlock,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "./flow";
import { Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT, questionById } from "./quiz";

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

// ---------------------------------------------------------------------------
// RULE 12 - content blocks (A2). Same doctrine as everything above: the base
// funnel with one thing wrong with its furniture.
// ---------------------------------------------------------------------------

/** A compliant, valid block of each kind, for breaking one at a time. */
const trustStrip = (): FlowBlock => ({
  kind: "trust-strip",
  practiceName: "Vitality Dental",
  chips: ["Open Saturdays", "Free parking"],
});
const testimonial = (): FlowBlock => ({
  kind: "testimonial",
  quote: "The team explained every step and I never felt rushed.",
  attribution: "Hannah, Enfield",
});
const faq = (): FlowBlock => ({
  kind: "faq",
  items: [
    { q: "How long does it take?", a: "The team will talk you through the timings at your visit." },
    { q: "Can I ask about the cost?", a: "Yes, and you will have the figures in writing first." },
  ],
});
const imageBlock = (): FlowBlock => ({
  kind: "image",
  image: "screens/aligners",
  alt: "A pair of clear aligners",
});

/** The base funnel with `blocks` on its welcome screen. */
function withBlocks(blocks: FlowBlock[]): FlowGraph {
  const g = base();
  g.nodes[0] = { id: "welcome", kind: "welcome", blocks };
  return g;
}

describe("rule 12: content blocks", () => {
  it("accepts one of every kind on a welcome screen", () => {
    const g = withBlocks([trustStrip(), testimonial(), faq(), imageBlock()]);
    expect(describeFlowFailures(validateFlow(g).failures)).toBe("");
  });

  it("accepts blocks on a result screen", () => {
    const g = base();
    const at = g.nodes.findIndex((n) => n.id === "out-high");
    g.nodes[at] = { id: "out-high", kind: "outcome", band: "high", blocks: [testimonial()] };
    expect(describeFlowFailures(validateFlow(g).failures)).toBe("");
  });

  it("rejects blocks on a question screen", () => {
    const g = base();
    g.nodes[1] = { ...g.nodes[1]!, blocks: [testimonial()] } as FlowNode;
    expect(codes(g)).toContain("blocks_wrong_screen");
  });

  it("rejects blocks on the contact screen", () => {
    const g = base();
    const at = g.nodes.findIndex((n) => n.id === "contact");
    g.nodes[at] = { id: "contact", kind: "contact", blocks: [faq()] } as FlowNode;
    expect(codes(g)).toContain("blocks_wrong_screen");
  });

  it("rejects more blocks on one screen than the limit", () => {
    const g = withBlocks(Array.from({ length: FLOW_LIMITS.blocksPerNode + 1 }, testimonial));
    expect(codes(g)).toContain("blocks_too_many");
  });

  it("rejects the same kind of block twice on one screen", () => {
    expect(codes(withBlocks([faq(), faq()]))).toContain("block_duplicate_kind");
  });

  it("rejects a block kind this build cannot render", () => {
    const g = withBlocks([{ kind: "video", src: "x" } as unknown as FlowBlock]);
    expect(codes(g)).toContain("block_kind_unknown");
  });

  it("rejects a blank string inside a block", () => {
    const block = trustStrip();
    if (block.kind !== "trust-strip") throw new Error("builder changed");
    block.chips = ["Open Saturdays", "   "];
    expect(codes(withBlocks([block]))).toContain("block_text_empty");
  });

  it("rejects a string over its own cap, naming the field", () => {
    const block = testimonial();
    if (block.kind !== "testimonial") throw new Error("builder changed");
    block.quote = "x".repeat(FLOW_LIMITS.quote + 1);
    const failure = validateFlow(withBlocks([block])).failures.find((f) => f.code === "block_text_too_long");
    expect(failure?.where).toBe('node "welcome".blocks[0].quote');
  });

  it("rejects a trust strip with no chips, and one with too many", () => {
    for (const chips of [[], Array.from({ length: FLOW_LIMITS.chips + 1 }, (_, i) => `chip ${i}`)]) {
      const block = trustStrip();
      if (block.kind !== "trust-strip") throw new Error("builder changed");
      block.chips = chips;
      expect(codes(withBlocks([block])), `${chips.length} chips`).toContain("trust_strip_chip_count");
    }
  });

  it("rejects a faq with fewer than two questions, and one with too many", () => {
    const one = [{ q: "How long?", a: "The team will say at your visit." }];
    const many = Array.from({ length: FLOW_LIMITS.faqItems + 1 }, (_, i) => ({ q: `q${i}?`, a: `a${i}` }));
    for (const items of [[], one, many]) {
      const block = faq();
      if (block.kind !== "faq") throw new Error("builder changed");
      block.items = items;
      expect(codes(withBlocks([block])), `${items.length} items`).toContain("faq_item_count");
    }
  });
});

// ---------------------------------------------------------------------------
// RULE 13 - a picture is a key in the curated manifest, fit for its slot.
// ---------------------------------------------------------------------------

describe("rule 13: picture references", () => {
  it("rejects a reference that is not in the library", () => {
    const g = withBlocks([{ kind: "image", image: "screens/does-not-exist", alt: "A picture" }]);
    expect(codes(g)).toContain("image_unknown");
  });

  it("rejects a raw URL, which is the whole reason references are keys", () => {
    for (const image of ["https://example.com/x.jpg", "/assess/conditions/crowded.webp", "../../secret.png"]) {
      const g = withBlocks([{ kind: "image", image, alt: "A picture" }]);
      expect(codes(g), image).toContain("image_unknown");
    }
  });

  it("rejects an answer tile stretched across a screen", () => {
    const g = withBlocks([{ kind: "image", image: "conditions/crowded", alt: "Crowded teeth" }]);
    expect(codes(g)).toContain("image_wrong_slot");
  });

  it("rejects a screen picture squeezed onto an answer card", () => {
    const g = base();
    g.nodes[1] = {
      id: Q_T,
      kind: "question",
      questionId: Q_TREATMENT,
      optionImages: treatmentPictures().map((o) => ({ ...o, image: "screens/aligners" })),
    };
    expect(codes(g)).toContain("image_wrong_slot");
  });
});

// ---------------------------------------------------------------------------
// RULE 14 - answer-card pictures: complete, real, and no ragged grids.
// ---------------------------------------------------------------------------

/** Every option of the treatment question, pictured. Seven options, seven tiles. */
function treatmentPictures(): { value: string; image: string }[] {
  const tiles = [
    "conditions/crowded",
    "conditions/gaps",
    "conditions/open-bite",
    "conditions/overbite",
    "conditions/underbite",
    "conditions/crossbite",
    "conditions/even-bite",
  ];
  return questionById(Q_TREATMENT)!.options.map((o, i) => ({ value: o.value, image: tiles[i]! }));
}

/** The base funnel with pictures on the treatment question's answers. */
function withPictures(optionImages: { value: string; image: string }[]): FlowGraph {
  const g = base();
  g.nodes[1] = { id: Q_T, kind: "question", questionId: Q_TREATMENT, optionImages };
  return g;
}

describe("rule 14: answer-card pictures", () => {
  it("accepts a question where every answer has a picture", () => {
    expect(describeFlowFailures(validateFlow(withPictures(treatmentPictures())).failures)).toBe("");
  });

  it("accepts the escape-hatch relaxation: only the LAST answer without a picture", () => {
    // quiz.ts smile_concern is the reason this relaxation exists at all: seven
    // conditions we have a render of, and "I'm not sure", which has no picture and
    // never will. Every escape hatch in the bank is written last.
    const all = treatmentPictures();
    expect(all[all.length - 1]!.value).toBe("other");
    expect(validateFlow(withPictures(all.slice(0, -1))).ok).toBe(true);
  });

  it("rejects a hole anywhere else: that is the ragged grid", () => {
    const missingMiddle = treatmentPictures().filter((o) => o.value !== "veneers");
    expect(codes(withPictures(missingMiddle))).toContain("option_images_ragged");
  });

  it("rejects two answers unpictured, even when one of them is the last", () => {
    expect(codes(withPictures(treatmentPictures().slice(0, -2)))).toContain("option_images_ragged");
  });

  it("rejects one lonely picture on an eight-answer question", () => {
    expect(codes(withPictures([treatmentPictures()[0]!]))).toContain("option_images_ragged");
  });

  it("rejects more answer pictures than the limit", () => {
    // Coercion caps the stored shape at the same number; this is the in-memory
    // path (the builder, the generator), which never goes through coercion.
    const flooded = Array.from({ length: FLOW_LIMITS.optionImages + 1 }, () => ({
      value: "invisalign",
      image: "conditions/crowded",
    }));
    expect(codes(withPictures(flooded))).toContain("option_images_too_many");
  });

  it("rejects a picture for an answer that question does not have", () => {
    const bogus = [...treatmentPictures(), { value: "sedation", image: "conditions/gaps" }];
    expect(codes(withPictures(bogus))).toContain("option_image_unknown_option");
  });

  it("rejects the same answer pictured twice", () => {
    const dupe = [...treatmentPictures(), { value: "invisalign", image: "conditions/gaps" }];
    expect(codes(withPictures(dupe))).toContain("option_image_duplicate");
  });

  it("rejects answer pictures on a screen that has no answers", () => {
    const g = base();
    g.nodes[0] = { id: "welcome", kind: "welcome", optionImages: treatmentPictures() } as unknown as FlowNode;
    expect(codes(g)).toContain("option_images_wrong_screen");
  });

  it("stays quiet about pictures when the question itself is unknown (rule 2 owns that)", () => {
    const g = base();
    g.nodes[1] = { id: Q_T, kind: "question", questionId: "invented", optionImages: treatmentPictures() };
    const hit = codes(g);
    expect(hit).toContain("unknown_question");
    expect(hit).not.toContain("option_images_ragged");
  });
});

// ---------------------------------------------------------------------------
// RULE 1, the second half: a graph may not use newer content under an older
// version number.
// ---------------------------------------------------------------------------

describe("rule 1: a version that can carry what the funnel holds", () => {
  it("still accepts a stored v1 funnel, because a bump must not take one offline", () => {
    expect(validateFlow({ ...base(), schemaVersion: 1 }).ok).toBe(true);
  });

  it("rejects blocks smuggled into a graph that declares v1", () => {
    const g = { ...withBlocks([testimonial()]), schemaVersion: 1 };
    expect(codes(g)).toContain("schema_version_too_old");
  });

  it("rejects answer pictures smuggled into a graph that declares v1", () => {
    const g = { ...withPictures(treatmentPictures()), schemaVersion: 1 };
    expect(codes(g)).toContain("schema_version_too_old");
  });

  it("reports a version from another era once, not twice", () => {
    const g = { ...withBlocks([testimonial()]), schemaVersion: FLOW_SCHEMA_VERSION + 1 };
    const hit = codes(g);
    expect(hit).toContain("schema_version");
    expect(hit).not.toContain("schema_version_too_old");
  });
});
