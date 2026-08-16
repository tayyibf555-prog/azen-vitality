// The write-time copy gate. Every assertion here is a rule that, if it stopped
// holding, would let non-compliant patient-facing copy into a live funnel with no
// other alarm anywhere: the row is written by a person after the suite ran.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FLOW_JARGON_PATTERNS,
  collectFlowCopy,
  describeFlowCopyHits,
  scanFlowCopy,
  scanFlowCopyText,
} from "./flow-copy";
import { FLOW_SCHEMA_VERSION, type FlowBlock, type FlowGraph } from "./flow";
import { FLOW_TEMPLATES, buildScratchFlow } from "./flow-templates";

/** A tiny graph with one of every copy-carrying field. Not a valid funnel; the
 *  copy scan is deliberately independent of the routing rules. */
function graphWithCopy(copy: {
  welcomeHeadline?: string;
  welcomeIntro?: string;
  questionTransition?: string;
  edgeTransition?: string;
  outcomeHeadline?: string;
}): FlowGraph {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    entry: "w",
    nodes: [
      { id: "w", kind: "welcome", headline: copy.welcomeHeadline, intro: copy.welcomeIntro },
      { id: "q", kind: "question", questionId: "treatment_interest", transition: copy.questionTransition },
      { id: "c", kind: "contact" },
      { id: "r", kind: "outcome", band: "high", headline: copy.outcomeHeadline },
    ],
    edges: [
      { from: "w", to: "q", answer: null },
      { from: "q", to: "c", answer: "invisalign", transition: copy.edgeTransition },
      { from: "c", to: "r", answer: "high" },
    ],
  };
}

describe("collectFlowCopy finds every authored patient-facing string", () => {
  it("collects all five copy fields, and nothing else", () => {
    const fields = collectFlowCopy(
      graphWithCopy({
        welcomeHeadline: "A welcome headline",
        welcomeIntro: "A welcome intro",
        questionTransition: "A question transition",
        edgeTransition: "An edge transition",
        outcomeHeadline: "An outcome headline",
      }),
    );
    expect(fields.map((f) => f.text).sort()).toEqual([
      "A welcome headline",
      "A welcome intro",
      "An edge transition",
      "An outcome headline",
      "A question transition",
    ].sort());
  });

  it("names each field so an owner can find it", () => {
    const fields = collectFlowCopy(graphWithCopy({ welcomeIntro: "hello", edgeTransition: "onward" }));
    expect(fields.find((f) => f.text === "hello")?.where).toBe('node "w".intro');
    expect(fields.find((f) => f.text === "onward")?.where).toBe("edge q -> c (invisalign).transition");
  });

  it("skips absent and blank copy, so an empty funnel scans clean", () => {
    expect(collectFlowCopy(graphWithCopy({}))).toEqual([]);
    expect(collectFlowCopy(graphWithCopy({ welcomeIntro: "   " }))).toEqual([]);
  });
});

describe("the jargon ban is absolute, and stricter than the landing lint", () => {
  it("catches NHS, private and privately in any usage", () => {
    for (const bad of ["Are you an NHS patient?", "This is a private assessment", "Seen privately before?"]) {
      const hits = scanFlowCopyText("x", bad);
      expect(hits.some((h) => h.category === "jargon"), bad).toBe(true);
    }
  });

  it("catches a bare 'private' that compliance.ts alone would let through", () => {
    // compliance.ts scopes "private" to funding-ish usage on purpose. This phrase
    // matches none of those, which is precisely why the second scanner exists.
    const text = "Somewhere private to talk it over";
    const hits = scanFlowCopyText("x", text);
    expect(hits.map((h) => h.category)).toContain("jargon");
  });

  it("stays byte-identical to the list the bank is walked with", () => {
    // The bank's own guard owns the canonical list. If someone widens or narrows
    // it there, this funnel copy must move with it or the two surfaces disagree.
    const src = readFileSync(
      resolve(process.cwd(), "src/lib/smile-assessment/area16-18-patient-copy-jargon.test.ts"),
      "utf8",
    );
    const line = src.match(/const FORBIDDEN = \[(.*)\];/)?.[1];
    expect(line).toBeTruthy();
    expect(line!.split(",").map((s) => s.trim())).toEqual(FLOW_JARGON_PATTERNS.map((r) => r.toString()));
  });
});

describe("the house banned-pattern lint is applied too", () => {
  it.each([
    ["guarantee", "We guarantee you will love it"],
    ["pain", "A completely pain free visit"],
    ["superlative", "The best dentist in London"],
    ["symbol", "Nearly there — one more question"],
    ["testimonial", "Read our 5 star reviews from happy patients"],
  ])("flags %s copy", (category, text) => {
    expect(scanFlowCopyText("x", text).map((h) => h.category)).toContain(category);
  });

  it("lets warm, compliant copy through", () => {
    expect(scanFlowCopyText("x", "That helps. Now, when you would like to get started.")).toEqual([]);
  });
});

describe("scanFlowCopy reports every offending string at once", () => {
  it("returns hits from more than one field in a single pass", () => {
    const hits = scanFlowCopy(
      graphWithCopy({
        welcomeIntro: "Our NHS list is open",
        edgeTransition: "We guarantee a result",
        outcomeHeadline: "The best clinic in town",
      }),
    );
    const wheres = new Set(hits.map((h) => h.where));
    expect(wheres.size).toBe(3);
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("describes hits one per line, naming the field and the phrase", () => {
    const line = describeFlowCopyHits(scanFlowCopy(graphWithCopy({ welcomeIntro: "Our NHS list is open" })));
    expect(line).toContain('node "w".intro');
    expect(line).toMatch(/NHS/i);
  });

  it("passes a graph with no authored copy at all", () => {
    expect(scanFlowCopy(graphWithCopy({}))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CONTENT BLOCKS (A2). A block is where a practice writes about ITSELF rather
// than about the next question, which is exactly the copy that gets a UK dental
// practice into trouble. If the scan does not reach into blocks, the gate has a
// hole shaped like the most dangerous field on the screen.
// ---------------------------------------------------------------------------

/** The base copy graph with blocks on the welcome screen. */
function graphWithBlocks(blocks: FlowBlock[]): FlowGraph {
  const g = graphWithCopy({});
  g.nodes[0] = { id: "w", kind: "welcome", blocks };
  return g;
}

const compliantBlocks = (): FlowBlock[] => [
  { kind: "trust-strip", practiceName: "Vitality Dental", chips: ["Open Saturdays", "Free parking"] },
  {
    kind: "testimonial",
    quote: "The team explained every step and I never felt rushed.",
    attribution: "Hannah, Enfield",
  },
  {
    kind: "faq",
    items: [
      { q: "How long does it take?", a: "The team will talk you through the timings at your visit." },
      { q: "What happens first?", a: "You will have a chat with a clinician about what you would like to change." },
    ],
  },
  { kind: "image", image: "screens/aligners", alt: "A pair of clear aligners" },
];

describe("the scan reaches into content blocks", () => {
  it("collects every authored string in every block kind, and names it", () => {
    const fields = collectFlowCopy(graphWithBlocks(compliantBlocks()));
    expect(fields.map((f) => f.where)).toEqual([
      'node "w".blocks[0].practiceName',
      'node "w".blocks[0].chips[0]',
      'node "w".blocks[0].chips[1]',
      'node "w".blocks[1].quote',
      'node "w".blocks[1].attribution',
      'node "w".blocks[2].items[0].q',
      'node "w".blocks[2].items[0].a',
      'node "w".blocks[2].items[1].q',
      'node "w".blocks[2].items[1].a',
      'node "w".blocks[3].alt',
    ]);
  });

  it("collects blocks on a result screen too, not only the welcome", () => {
    const g = graphWithCopy({});
    g.nodes[3] = { id: "r", kind: "outcome", band: "high", blocks: [compliantBlocks()[1]!] };
    expect(collectFlowCopy(g).map((f) => f.where)).toEqual([
      'node "r".blocks[0].quote',
      'node "r".blocks[0].attribution',
    ]);
  });

  it("does not treat the picture reference as copy: a key is not a sentence", () => {
    const fields = collectFlowCopy(graphWithBlocks([compliantBlocks()[3]!]));
    expect(fields.map((f) => f.text)).toEqual(["A pair of clear aligners"]);
  });

  it("lets a real, plainly written testimonial through", () => {
    expect(describeFlowCopyHits(scanFlowCopy(graphWithBlocks(compliantBlocks())))).toBe("");
  });

  it.each([
    // A quote is not exempt because a patient said it: publishing it is the claim.
    ["testimonial", { kind: "testimonial", quote: "Honestly the best dentist in London", attribution: "R" }],
    ["testimonial", { kind: "testimonial", quote: "It was completely pain free", attribution: "R" }],
    ["testimonial", { kind: "testimonial", quote: "Lovely people", attribution: "Read our 5 star reviews" }],
    ["trust strip chip", { kind: "trust-strip", practiceName: "V", chips: ["Rated 4.9 out of 5"] }],
    ["trust strip name", { kind: "trust-strip", practiceName: "The No 1 practice", chips: ["Parking"] }],
    ["faq answer", {
      kind: "faq",
      items: [
        { q: "Do you take NHS patients?", a: "Yes, ask the team." },
        { q: "Is there parking?", a: "Yes, at the front." },
      ],
    }],
    ["faq answer with a promise", {
      kind: "faq",
      items: [
        { q: "Will it work?", a: "We guarantee you will be happy with it." },
        { q: "Is there parking?", a: "Yes, at the front." },
      ],
    }],
    ["image alt", { kind: "image", image: "screens/aligners", alt: "Our award winning practice" }],
  ])("catches non-compliant copy in a %s", (_label, block) => {
    const hits = scanFlowCopy(graphWithBlocks([block as FlowBlock]));
    expect(hits.length, JSON.stringify(block)).toBeGreaterThan(0);
  });

  it("reports a block hit alongside the ordinary copy hits, in one pass", () => {
    const g = graphWithCopy({ welcomeIntro: "Our NHS list is open" });
    g.nodes[3] = {
      id: "r",
      kind: "outcome",
      band: "high",
      blocks: [{ kind: "testimonial", quote: "The best in town", attribution: "R" }],
    };
    const wheres = scanFlowCopy(g).map((h) => h.where);
    expect(wheres).toContain('node "w".intro');
    expect(wheres).toContain('node "r".blocks[0].quote');
  });
});

describe("every shipped template survives its own gate", () => {
  // The templates are the copy an owner starts from. If a template could not be
  // saved through the write path that scans it, the feature contradicts itself.
  it.each(FLOW_TEMPLATES.map((t) => [t.key, t] as const))("%s scans clean", (_key, t) => {
    expect(describeFlowCopyHits(scanFlowCopy(t.build()))).toBe("");
  });

  it("start from scratch scans clean", () => {
    expect(scanFlowCopy(buildScratchFlow())).toEqual([]);
  });
});
