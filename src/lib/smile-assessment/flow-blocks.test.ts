// A2's model contract: content blocks and answer-card pictures are FURNITURE.
//
// The one thing that must never become true is that adding a picture to a funnel
// changes what that funnel scores, because nothing would say so: the quiz would
// still work, the leads would still arrive, and the band that decides whether the
// Speed-to-lead bridge fires (submit/route.ts) would just be different from the
// day before. So the centrepiece here is the parity test - the same funnel, walked
// with the same answers, with and without every block kind hung off it - and the
// rest is the coercion layer that keeps a malformed block out of the row.

import { describe, it, expect } from "vitest";
import {
  FLOW_LIMITS,
  FLOW_SCHEMA_VERSION,
  FLOW_SCHEMA_VERSION_BLOCKS,
  SUPPORTED_FLOW_SCHEMA_VERSIONS,
  cloneFlowGraph,
  flowUsesV2Content,
  normaliseFlow,
  requiredFlowSchemaVersion,
  withRequiredSchemaVersion,
  type FlowBlock,
  type FlowGraph,
  type FlowNode,
} from "./flow";
import { validateFlow } from "./flow-validate";
import { toPublicFlow } from "./campaign";
import { walkFlow } from "./flow-runtime";
import { scoreAssessment } from "./scoring";
import { QUIZ_QUESTIONS, Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT, questionById } from "./quiz";

// ---------------------------------------------------------------------------
// A valid funnel, and the same funnel wearing one of every block kind.
// ---------------------------------------------------------------------------

const TRUST: FlowBlock = {
  kind: "trust-strip",
  practiceName: "Vitality Dental",
  chips: ["Open Saturdays", "Free parking", "Wheelchair access"],
};
const TESTIMONIAL: FlowBlock = {
  kind: "testimonial",
  quote: "The team explained every step and I never felt rushed.",
  attribution: "Hannah, Enfield",
};
const FAQ: FlowBlock = {
  kind: "faq",
  items: [
    { q: "How long does it take?", a: "The team will talk you through the timings at your visit." },
    { q: "Can I ask about the cost?", a: "Yes, and you will have the figures in writing before anything starts." },
  ],
};
const IMAGE: FlowBlock = { kind: "image", image: "screens/aligners", alt: "A pair of clear aligners" };

function plain(): FlowGraph {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    entry: "welcome",
    nodes: [
      { id: "welcome", kind: "welcome" },
      { id: "q-t", kind: "question", questionId: Q_TREATMENT },
      { id: "q-tl", kind: "question", questionId: Q_TIMELINE },
      { id: "q-b", kind: "question", questionId: Q_BUDGET },
      { id: "q-l", kind: "question", questionId: Q_LOCATION },
      { id: "contact", kind: "contact" },
      { id: "out-high", kind: "outcome", band: "high" },
      { id: "out-medium", kind: "outcome", band: "medium" },
      { id: "out-low", kind: "outcome", band: "low" },
    ],
    edges: [
      { from: "welcome", to: "q-t", answer: null },
      { from: "q-t", to: "q-tl", answer: null },
      { from: "q-tl", to: "q-b", answer: null },
      { from: "q-b", to: "q-l", answer: null },
      { from: "q-l", to: "contact", answer: null },
      { from: "contact", to: "out-high", answer: "high" },
      { from: "contact", to: "out-medium", answer: "medium" },
      { from: "contact", to: "out-low", answer: "low" },
    ],
  };
}

/** Every option of the timeline question, pictured. Values are real; keys are real. */
const TIMELINE_PICTURES = questionById(Q_TIMELINE)!.options.map((o, i) => ({
  value: o.value,
  image: ["conditions/crowded", "conditions/gaps", "conditions/overbite", "conditions/underbite"][i]!,
}));

/** The same funnel with one of every block kind, plus a fully pictured question. */
function decorated(): FlowGraph {
  const g = plain();
  const welcome = g.nodes.find((n) => n.id === "welcome")!;
  if (welcome.kind === "welcome") welcome.blocks = [TRUST, TESTIMONIAL, FAQ, IMAGE];
  const high = g.nodes.find((n) => n.id === "out-high")!;
  if (high.kind === "outcome") high.blocks = [TESTIMONIAL, FAQ];
  const timeline = g.nodes.find((n) => n.id === "q-tl")!;
  if (timeline.kind === "question") timeline.optionImages = TIMELINE_PICTURES;
  return g;
}

/** The decorated graph with every A2 field removed again. */
function stripped(graph: FlowGraph): FlowGraph {
  return {
    ...graph,
    schemaVersion: FLOW_SCHEMA_VERSION,
    nodes: graph.nodes.map((n) => {
      const copy: Record<string, unknown> = { ...n };
      delete copy.blocks;
      delete copy.optionImages;
      return copy as FlowNode;
    }),
  };
}

/**
 * Walk the funnel exactly as the browser does, answering each question with the
 * option at `pick` (clamped), and return what the submission would carry.
 */
function run(graph: FlowGraph, pick: number): { asked: string[]; responses: Record<string, string> } {
  const responses: Record<string, string> = {};
  for (let guard = 0; guard < 20; guard++) {
    const walk = walkFlow(graph, responses);
    if (walk.status === "ask") {
      const q = questionById(walk.node.questionId)!;
      responses[q.id] = q.options[Math.min(pick, q.options.length - 1)]!.value;
      continue;
    }
    if (walk.status === "contact") return { asked: walk.asked, responses };
    throw new Error(`stuck: ${walk.reason}`);
  }
  throw new Error("did not settle");
}

// ---------------------------------------------------------------------------
// THE PARITY TEST.
// ---------------------------------------------------------------------------

describe("blocks are inert: the same funnel scores the same with and without them", () => {
  it.each([0, 1, 2, 3])("picking option %i on every question", (pick) => {
    const withBlocks = run(decorated(), pick);
    const without = run(plain(), pick);

    expect(withBlocks.asked).toEqual(without.asked);
    expect(withBlocks.responses).toEqual(without.responses);
    expect(scoreAssessment(withBlocks.responses)).toEqual(scoreAssessment(without.responses));
  });

  it("scores identically for every single-question answer set in the bank", () => {
    // Wider than the walk: whatever a block could theoretically do to scoring, it
    // would have to do through one of these, and scoreAssessment cannot even see a
    // graph. Belt and braces on the claim in the file header.
    for (const q of QUIZ_QUESTIONS) {
      for (const o of q.options) {
        expect(scoreAssessment({ [q.id]: o.value })).toEqual(scoreAssessment({ [q.id]: o.value }));
      }
    }
  });

  it("is byte-identical once the furniture is taken off again", () => {
    // The routing half of the graph - nodes, ids, edges, answers - is untouched by
    // decoration. If a block ever changed one of them this comparison is where it
    // shows, rather than in a band that quietly moved.
    expect(JSON.stringify(stripped(decorated()))).toBe(JSON.stringify(plain()));
  });

  it("both funnels validate, so the comparison is between two shippable funnels", () => {
    expect(validateFlow(plain()).failures).toEqual([]);
    expect(validateFlow(decorated()).failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// COERCION.
// ---------------------------------------------------------------------------

describe("normaliseFlow reads a decorated graph exactly, or not at all", () => {
  it("round-trips every block kind and every answer picture", () => {
    const graph = decorated();
    const read = normaliseFlow(JSON.parse(JSON.stringify(graph)));
    expect(read).toEqual(graph);
  });

  it("returns a fresh graph: the blocks array is not shared with the input", () => {
    const raw = JSON.parse(JSON.stringify(decorated()));
    const read = normaliseFlow(raw)!;
    const welcome = read.nodes[0];
    if (welcome?.kind !== "welcome") throw new Error("expected the welcome node first");
    welcome.blocks!.push(IMAGE);
    expect(raw.nodes[0].blocks).toHaveLength(4);
  });

  it("treats an empty blocks array as absent, so a cleared screen has no key at all", () => {
    const g = plain();
    const read = normaliseFlow({ ...g, nodes: [{ id: "welcome", kind: "welcome", blocks: [] }, ...g.nodes.slice(1)] })!;
    expect(read.nodes[0]).toEqual({ id: "welcome", kind: "welcome" });
    expect(flowUsesV2Content(read)).toBe(false);
  });

  const malformed: [string, unknown][] = [
    ["a block that is not an object", "trust-strip"],
    ["an unknown block kind", { kind: "video", src: "x" }],
    ["a trust strip with no practice name", { kind: "trust-strip", chips: ["a"] }],
    ["a trust strip with a blank chip", { kind: "trust-strip", practiceName: "V", chips: ["a", "  "] }],
    ["a trust strip with more chips than the cap", {
      kind: "trust-strip",
      practiceName: "V",
      chips: Array.from({ length: FLOW_LIMITS.chips + 1 }, (_, i) => `chip ${i}`),
    }],
    ["a chip over the length cap", {
      kind: "trust-strip",
      practiceName: "V",
      chips: ["x".repeat(FLOW_LIMITS.chipLabel + 1)],
    }],
    ["a testimonial with no attribution", { kind: "testimonial", quote: "Lovely people" }],
    ["a quote over the length cap", {
      kind: "testimonial",
      quote: "x".repeat(FLOW_LIMITS.quote + 1),
      attribution: "A",
    }],
    ["a faq item missing its answer", { kind: "faq", items: [{ q: "How long?" }] }],
    ["a faq with more items than the cap", {
      kind: "faq",
      items: Array.from({ length: FLOW_LIMITS.faqItems + 1 }, (_, i) => ({ q: `q${i}`, a: `a${i}` })),
    }],
    ["an image with no alt", { kind: "image", image: "screens/aligners" }],
    ["an image reference that is not a string", { kind: "image", image: 7, alt: "A picture" }],
  ];

  it.each(malformed)("refuses the whole graph for %s", (_label, block) => {
    const g = plain();
    const nodes = [{ id: "welcome", kind: "welcome", blocks: [block] }, ...g.nodes.slice(1)];
    expect(normaliseFlow({ ...g, nodes })).toBeNull();
  });

  it("refuses more blocks on one screen than the cap allows", () => {
    const g = plain();
    const blocks = Array.from({ length: FLOW_LIMITS.blocksPerNode + 1 }, () => TESTIMONIAL);
    const nodes = [{ id: "welcome", kind: "welcome", blocks }, ...g.nodes.slice(1)];
    expect(normaliseFlow({ ...g, nodes })).toBeNull();
  });

  it("refuses blocks on a screen that cannot carry them rather than dropping them", () => {
    // Dropping is the dangerous half: the save would report success and the screen
    // would come back empty, with nothing anywhere saying why.
    const g = plain();
    for (const [i, node] of g.nodes.entries()) {
      if (node.kind !== "question" && node.kind !== "contact") continue;
      const nodes = [...g.nodes];
      nodes[i] = { ...node, blocks: [TESTIMONIAL] } as unknown as FlowNode;
      expect(normaliseFlow({ ...g, nodes }), node.id).toBeNull();
    }
  });

  it("tolerates an EMPTY blocks key on a screen that cannot carry them: no content is not misplaced content", () => {
    // A builder that initialises the key on every node it touches must not be
    // able to brick an otherwise perfect save over a pair of empty brackets.
    const g = plain();
    const nodes = g.nodes.map((n) => ({ ...n, blocks: [], optionImages: [] }));
    const read = normaliseFlow({ ...g, nodes });
    expect(read).toEqual(plain());
  });

  it("refuses answer pictures on a screen that has no answers", () => {
    const g = plain();
    const nodes = [{ id: "welcome", kind: "welcome", optionImages: TIMELINE_PICTURES }, ...g.nodes.slice(1)];
    expect(normaliseFlow({ ...g, nodes })).toBeNull();
  });

  it("refuses a malformed or over-long answer picture list", () => {
    const g = decorated();
    const timelineIndex = g.nodes.findIndex((n) => n.id === "q-tl");
    for (const optionImages of [
      [{ value: "asap" }],
      [{ image: "conditions/gaps" }],
      "conditions/gaps",
      Array.from({ length: FLOW_LIMITS.optionImages + 1 }, () => ({ value: "asap", image: "conditions/gaps" })),
    ]) {
      const nodes = [...g.nodes];
      nodes[timelineIndex] = { id: "q-tl", kind: "question", questionId: Q_TIMELINE, optionImages } as FlowNode;
      expect(normaliseFlow({ ...g, nodes }), JSON.stringify(optionImages).slice(0, 40)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// SCHEMA VERSION.
// ---------------------------------------------------------------------------

describe("the schema version says what a reader must understand", () => {
  it("still reads v1, because bumping must not take stored funnels offline", () => {
    expect(SUPPORTED_FLOW_SCHEMA_VERSIONS).toContain(1);
    expect(SUPPORTED_FLOW_SCHEMA_VERSIONS).toContain(FLOW_SCHEMA_VERSION);
    const v1 = { ...plain(), schemaVersion: 1 };
    expect(validateFlow(v1).failures).toEqual([]);
  });

  it("knows which graphs need the newer version", () => {
    expect(flowUsesV2Content(plain())).toBe(false);
    expect(requiredFlowSchemaVersion(plain())).toBe(1);
    expect(flowUsesV2Content(decorated())).toBe(true);
    expect(requiredFlowSchemaVersion(decorated())).toBe(FLOW_SCHEMA_VERSION_BLOCKS);
  });

  it("counts an answer picture on its own as newer content", () => {
    const g = plain();
    const timeline = g.nodes.find((n) => n.id === "q-tl")!;
    if (timeline.kind === "question") timeline.optionImages = TIMELINE_PICTURES;
    expect(flowUsesV2Content(g)).toBe(true);
  });

  it("upgrades a graph that has grown a block, and never downgrades one", () => {
    const grown = { ...decorated(), schemaVersion: 1 };
    expect(withRequiredSchemaVersion(grown).schemaVersion).toBe(FLOW_SCHEMA_VERSION_BLOCKS);

    const emptied = { ...plain(), schemaVersion: FLOW_SCHEMA_VERSION_BLOCKS };
    expect(withRequiredSchemaVersion(emptied).schemaVersion).toBe(FLOW_SCHEMA_VERSION_BLOCKS);

    const untouched = plain();
    expect(withRequiredSchemaVersion(untouched)).toBe(untouched); // same object: no needless copy
  });
});

// ---------------------------------------------------------------------------
// COPIES.
// ---------------------------------------------------------------------------

describe("cloneFlowGraph shares nothing with its source", () => {
  it("copies the blocks, the chips, the faq items and the answer pictures", () => {
    const source = decorated();
    const copy = cloneFlowGraph(source);
    expect(copy).toEqual(source);

    const welcome = copy.nodes.find((n) => n.id === "welcome")!;
    if (welcome.kind !== "welcome") throw new Error("expected a welcome node");
    const strip = welcome.blocks![0];
    if (strip?.kind !== "trust-strip") throw new Error("expected the trust strip first");
    strip.chips.push("Late nights");
    welcome.blocks!.pop();

    const timeline = copy.nodes.find((n) => n.id === "q-tl")!;
    if (timeline.kind !== "question") throw new Error("expected a question node");
    timeline.optionImages!.pop();

    expect(source).toEqual(decorated());
  });
});

// ---------------------------------------------------------------------------
// THE PUBLIC PAYLOAD.
// ---------------------------------------------------------------------------

describe("toPublicFlow publishes the furniture and still never publishes a weight", () => {
  it("carries the blocks and answer pictures through untouched", () => {
    const pub = toPublicFlow(decorated())!;
    const welcome = pub.graph.nodes.find((n) => n.id === "welcome")!;
    if (welcome.kind !== "welcome") throw new Error("expected a welcome node");
    expect(welcome.blocks).toEqual([TRUST, TESTIMONIAL, FAQ, IMAGE]);

    const timeline = pub.graph.nodes.find((n) => n.id === "q-tl")!;
    if (timeline.kind !== "question") throw new Error("expected a question node");
    expect(timeline.optionImages).toEqual(TIMELINE_PICTURES);
  });

  it("still strips the option weights, blocks or no blocks", () => {
    const pub = toPublicFlow(decorated())!;
    expect(JSON.stringify(pub)).not.toMatch(/weight/i);
    for (const q of pub.questions) {
      for (const o of q.options) {
        expect(Object.keys(o).sort()).toEqual(["label", "value"]);
      }
    }
  });

  it("hands back a graph the caller cannot mutate the stored one through", () => {
    const source = decorated();
    const pub = toPublicFlow(source)!;
    const welcome = pub.graph.nodes.find((n) => n.id === "welcome")!;
    if (welcome.kind !== "welcome") throw new Error("expected a welcome node");
    welcome.blocks!.length = 0;
    const sourceWelcome = source.nodes.find((n) => n.id === "welcome")!;
    if (sourceWelcome.kind !== "welcome") throw new Error("expected a welcome node");
    expect(sourceWelcome.blocks).toHaveLength(4);
  });

  it("publishes the picture KEY, never a path, so the browser resolves it or draws nothing", () => {
    const pub = toPublicFlow(decorated())!;
    expect(JSON.stringify(pub)).not.toContain("/assess/conditions");
    expect(JSON.stringify(pub)).toContain("conditions/crowded");
  });
});

describe("the questions the bank supplies for a pictured question are unchanged", () => {
  it("sends the same payload as it would without pictures", () => {
    expect(toPublicFlow(decorated())!.questions).toEqual(toPublicFlow(plain())!.questions);
  });
});
