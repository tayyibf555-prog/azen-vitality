// C1's MODEL CONTRACT: `booking` is a block, and a block is all it is.
//
// The whole design of C1 rests on one claim - that putting a booking screen at the
// end of a funnel can be done WITHOUT adding a node. If that claim is wrong the
// damage is silent rather than loud: step-numbering.ts pushes the collapsed result
// slot last unconditionally, so a node with a longer path than the outcome's would
// be charted BEFORE the result it comes after, and completionPct ("reached any
// result screen") would quietly stop meaning that. Nothing would error. The chart
// would just describe a funnel nobody has.
//
// So the centrepiece here is the two byte-identity tests: the same funnel, with and
// without a booking block, produces the same numbering and the same labels - and,
// as for every other block kind, the same score.
//
// The rest is the seam it lives in: coercion, the one place it is legal, the
// compliance scan reading both its strings, and the phone projection drawing it.

import { describe, it, expect } from "vitest";
import {
  FLOW_BLOCK_KINDS,
  FLOW_LIMITS,
  FLOW_SCHEMA_VERSION,
  FLOW_SCHEMA_VERSION_BLOCKS,
  acceptsBlockKind,
  blockCopyFields,
  blockKindsForScreen,
  cloneFlowGraph,
  flowUsesV2Content,
  normaliseFlow,
  type FlowBlock,
  type FlowGraph,
  type FlowNode,
} from "./flow";
import { validateFlow } from "./flow-validate";
import { collectFlowCopy, scanFlowCopy } from "./flow-copy";
import {
  addBlock,
  addableBlockKinds,
  setBlockText,
  starterBlock,
  type FlowEditResult,
} from "./flow-edit";
import { blockViews, bookingBlockView, inlineBlockViews } from "./flow-block-view";
import { phoneBlocks, screenFor } from "./flow-phone-screen";
import { stepNumbering } from "./step-numbering";
import { stepLabels } from "./step-labels";
import { toPublicFlow } from "./campaign";
import { walkFlow } from "./flow-runtime";
import { scoreAssessment } from "./scoring";
import { Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT, questionById } from "./quiz";

const BOOKING: FlowBlock = {
  kind: "booking",
  headline: "Book your appointment now",
  blurb: "Pick a time that suits you and we will hold it for you.",
};
const TESTIMONIAL: FlowBlock = {
  kind: "testimonial",
  quote: "The team explained every step and I never felt rushed.",
  attribution: "Hannah, Enfield",
};

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

/** The same funnel, with a booking invitation on every result screen. */
function booked(): FlowGraph {
  const g = plain();
  for (const n of g.nodes) {
    if (n.kind === "outcome") n.blocks = [{ ...BOOKING }];
  }
  return g;
}

/** flow-edit.test.ts's own helpers, so an unexpected refusal names itself. */
function must(result: FlowEditResult): FlowGraph {
  if (!result.ok) throw new Error(`expected an edit, got: ${result.reason}`);
  return result.graph;
}
function refusal(result: FlowEditResult): string {
  if (result.ok) throw new Error("expected a refusal, got an edited graph");
  return result.reason;
}

function outcomeOf(g: FlowGraph, id: string): FlowNode {
  const node = g.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

/** Every answer, so the walk reaches the contact step. */
function allAnswers(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of [Q_TREATMENT, Q_TIMELINE, Q_BUDGET, Q_LOCATION]) {
    out[id] = questionById(id)!.options[0]!.value;
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 1. THE CENTREPIECE: a block adds no step.
 * ------------------------------------------------------------------------- */

describe("a booking block changes nothing about the shape of the funnel", () => {
  it("produces byte-identical step numbering", () => {
    // MUTATION: make this a NODE instead of a block and the numbering grows a
    // slot whose depth is greater than the outcome's - which step-numbering.ts
    // pushes last unconditionally, so the drop-off chart draws "Booking" then
    // "Result", backwards, and completionPct stops meaning "reached a result".
    expect(JSON.stringify(stepNumbering(booked()))).toBe(JSON.stringify(stepNumbering(plain())));

    // AND THE ORDINALS, WHICH THAT LINE CANNOT SEE. `ordinals` is a ReadonlyMap,
    // and JSON.stringify renders a Map as "{}" - so the comparison above holds
    // screens, stepCount, contactStep and outcomeStep to each other and lets the
    // map through untouched. The map is the half the public quiz reads
    // (stepIndexOf is a map lookup), and it is also the half `screens` cannot
    // stand in for, because screens names only the FIRST node of each slot: all
    // three result nodes could drop out of the map with everything above still
    // byte-identical, and every booked funnel would report zero completions.
    //
    // MUTATION: skip a block-bearing node when the ordinals are handed out, or
    // give it a slot of its own, and this goes red while the line above stays
    // green.
    expect([...stepNumbering(booked()).ordinals.entries()]).toEqual([
      ...stepNumbering(plain()).ordinals.entries(),
    ]);
  });

  it("produces byte-identical step labels", () => {
    const a = stepLabels(plain(), stepNumbering(plain()));
    const b = stepLabels(booked(), stepNumbering(booked()));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("routes and scores identically, step by step, with the same answers", () => {
    // The A2 doctrine held for the one block kind that is not cosmetic: the
    // BEHAVIOUR is a phase of the runtime, and the model still carries nothing but
    // two strings, which parseResponses and scoreAssessment never see.
    const ids = [Q_TREATMENT, Q_TIMELINE, Q_BUDGET, Q_LOCATION];
    const answers: Record<string, string> = {};
    // Every prefix of the walk, not just the finished one: a block that changed
    // routing would do it at one step, and only comparing the end would miss it.
    for (const id of [null, ...ids]) {
      if (id) answers[id] = questionById(id)!.options[0]!.value;
      expect(JSON.stringify(walkFlow(booked(), answers))).toBe(
        JSON.stringify(walkFlow(plain(), answers)),
      );
    }
    expect(scoreAssessment(allAnswers()).band).toBe(scoreAssessment(answers).band);
  });

  it("still validates, and still publishes to the browser", () => {
    expect(validateFlow(booked()).ok).toBe(true);
    const published = toPublicFlow(booked());
    expect(published).not.toBeNull();
    // The words travel: they are what the button says, and the button is drawn
    // client-side from the graph the page ships.
    expect(JSON.stringify(published)).toContain(BOOKING.headline);
  });
});

/* ---------------------------------------------------------------------------
 * 2. Coercion.
 * ------------------------------------------------------------------------- */

describe("reading a stored booking block", () => {
  it("reads one back exactly, and hands out a fresh object", () => {
    const round = normaliseFlow(JSON.parse(JSON.stringify(booked())));
    expect(round).not.toBeNull();
    expect(bookingBlockView(outcomeOf(round!, "out-high"))).toEqual({
      kind: "booking",
      headline: BOOKING.headline,
      blurb: BOOKING.blurb,
    });
    const clone = cloneFlowGraph(booked());
    const source = booked();
    expect(clone.nodes).toEqual(source.nodes);
    // MUTATION: shallow-copy the node and the campaign row's own array is shared
    // with whatever the builder edits next.
    expect(cloneFlowGraph(source).nodes[6]).not.toBe(source.nodes[6]);
  });

  it("refuses a block missing either of its two strings", () => {
    // MUTATION: default the missing one and a patient gets a button with no words
    // on it, or a heading with nothing under it, from a save that said "done".
    for (const bad of [
      { kind: "booking", blurb: "x" },
      { kind: "booking", headline: "x" },
      { kind: "booking", headline: "  ", blurb: "x" },
      { kind: "booking", headline: "x", blurb: "" },
    ]) {
      const g = plain();
      (g.nodes[6] as { blocks?: unknown }).blocks = [bad];
      expect(normaliseFlow(JSON.parse(JSON.stringify(g))), JSON.stringify(bad)).toBeNull();
    }
  });

  it("refuses copy over its caps", () => {
    const g = plain();
    (g.nodes[6] as { blocks?: unknown }).blocks = [
      { kind: "booking", headline: "x".repeat(FLOW_LIMITS.bookingHeadline + 1), blurb: "y" },
    ];
    expect(normaliseFlow(JSON.parse(JSON.stringify(g)))).toBeNull();
  });

  it("needs the blocks schema version, like every other block", () => {
    expect(flowUsesV2Content(booked())).toBe(true);
    expect(flowUsesV2Content(plain())).toBe(false);
    expect(FLOW_SCHEMA_VERSION_BLOCKS).toBe(2);
  });
});

/* ---------------------------------------------------------------------------
 * 3. THE ONE SCREEN IT IS LEGAL ON.
 * ------------------------------------------------------------------------- */

describe("a booking invitation belongs on a result screen and nowhere else", () => {
  it("says so in the model, for every kind at once", () => {
    expect(blockKindsForScreen("outcome")).toEqual([...FLOW_BLOCK_KINDS]);
    expect(blockKindsForScreen("welcome")).toEqual(["trust-strip", "testimonial", "faq", "image"]);
    expect(blockKindsForScreen("question")).toEqual([]);
    expect(blockKindsForScreen("contact")).toEqual([]);
    expect(acceptsBlockKind("outcome", "booking")).toBe(true);
    expect(acceptsBlockKind("welcome", "booking")).toBe(false);
  });

  // MUTATION: allow it on the welcome screen and the first thing a visitor sees
  // on a page the practice paid for the click on is a button that skips the
  // funnel - no answers, no score, no lead, and a slot taken out of the diary.
  it("is refused by rule 12 on the opening screen, naming what that screen takes", () => {
    const g = plain();
    (g.nodes[0] as { blocks?: unknown }).blocks = [{ ...BOOKING }];
    const failures = validateFlow(g).failures.filter((f) => f.code === "block_kind_wrong_screen");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.rule).toBe(12);
    expect(failures[0]!.where).toBe('node "welcome".blocks[0]');
    expect(failures[0]!.message).toContain("result screen");
    expect(validateFlow(g).ok).toBe(false);
  });

  it("still reports the block's own problems, so placement is not a first round", () => {
    // All failures at once is the house doctrine; an owner who moves the block
    // must not then discover its copy was too long all along.
    const g = plain();
    (g.nodes[0] as { blocks?: unknown }).blocks = [
      { kind: "booking", headline: "x".repeat(FLOW_LIMITS.bookingHeadline + 5), blurb: "y" },
    ];
    const codes = validateFlow(g).failures.map((f) => f.code);
    expect(codes).toContain("block_kind_wrong_screen");
    expect(codes).toContain("block_text_too_long");
  });

  it("is offered by the picker on a result screen only", () => {
    // MUTATION: source addableBlockKinds from FLOW_BLOCK_KINDS again and the rail
    // offers a block addBlock then refuses - a picker that lies.
    expect(addableBlockKinds(plain(), "out-high")).toContain("booking");
    expect(addableBlockKinds(plain(), "welcome")).not.toContain("booking");
    expect(refusal(addBlock(plain(), "welcome", BOOKING))).toContain("result screen");
    expect(validateFlow(must(addBlock(plain(), "out-high", BOOKING))).ok).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * 4. Both strings are patient-facing copy.
 * ------------------------------------------------------------------------- */

describe("the words on the button are scanned like every other authored line", () => {
  it("puts both of them in blockCopyFields, which is what the scan reads", () => {
    expect(blockCopyFields(BOOKING)).toEqual([
      { field: "headline", text: BOOKING.headline, max: FLOW_LIMITS.bookingHeadline },
      { field: "blurb", text: BOOKING.blurb, max: FLOW_LIMITS.bookingBlurb },
    ]);
    const paths = collectFlowCopy(booked()).map((c) => c.where);
    expect(paths).toContain('node "out-high".blocks[0].headline');
    expect(paths).toContain('node "out-high".blocks[0].blurb');
  });

  // MUTATION: leave either string out of blockCopyFields and it ships to a
  // patient unscanned - and a booking button is exactly where a practice is
  // tempted to promise a same-day, guaranteed, pain-free appointment.
  it("catches a promise in either half", () => {
    const g = plain();
    (g.nodes[6] as { blocks?: unknown }).blocks = [
      { kind: "booking", headline: "Guaranteed same day", blurb: "A pain-free visit, we promise." },
    ];
    const hits = scanFlowCopy(g);
    expect(hits.map((h) => h.where)).toContain('node "out-high".blocks[0].headline');
    expect(hits.map((h) => h.where)).toContain('node "out-high".blocks[0].blurb');
  });

  it("seeds a starter a practice is allowed to publish", () => {
    const starter = starterBlock("booking");
    expect(starter).not.toBeNull();
    const g = must(addBlock(plain(), "out-high", starter!));
    expect(validateFlow(g).ok).toBe(true);
    expect(scanFlowCopy(g)).toEqual([]);
    // It says what the button DOES; it promises nothing about when a time is free.
    expect(JSON.stringify(starter)).not.toMatch(/today|same day|guarantee/i);
  });

  it("lets an owner reword either line, and only those two", () => {
    const g = must(addBlock(plain(), "out-high", { ...BOOKING }));
    const reworded = must(setBlockText(g, "out-high", 0, "headline", "See our next free time"));
    expect(bookingBlockView(outcomeOf(reworded, "out-high"))?.headline).toBe(
      "See our next free time",
    );
    expect(refusal(setBlockText(g, "out-high", 0, "siteId", "site-rv"))).toContain("siteId");
    // MUTATION: allow a blank and normaliseFlow refuses the whole graph on the
    // next read, which reads to an owner as "the funnel could not be read".
    expect(refusal(setBlockText(g, "out-high", 0, "blurb", "   "))).toContain("empty");
  });
});

/* ---------------------------------------------------------------------------
 * 5. The projections: drawn as a picture, never as a section.
 * ------------------------------------------------------------------------- */

describe("what each renderer is handed", () => {
  it("gives the public result screen the furniture WITHOUT the booking block", () => {
    const g = plain();
    (g.nodes[6] as { blocks?: unknown }).blocks = [TESTIMONIAL, { ...BOOKING }];
    const node = outcomeOf(g, "out-high");
    // MUTATION: hand FunnelBlocks the raw blockViews and the result screen grows a
    // bordered strip with nothing inside it, on every funnel that offers booking.
    expect(inlineBlockViews(node).map((v) => v.kind)).toEqual(["testimonial"]);
    expect(blockViews(node).map((v) => v.kind)).toEqual(["testimonial", "booking"]);
    expect(bookingBlockView(node)).toEqual({
      kind: "booking",
      headline: BOOKING.headline,
      blurb: BOOKING.blurb,
    });
  });

  it("is identical either way for a funnel that has no booking block", () => {
    const node = outcomeOf(plain(), "out-high");
    expect(inlineBlockViews(node)).toEqual(blockViews(node));
    expect(bookingBlockView(node)).toBeNull();
  });

  it("draws it on the phone mini as its own two authored lines", () => {
    // The owner opens the preview to read the words back, so both travel verbatim
    // rather than being summarised the way a faq's items are.
    expect(phoneBlocks(outcomeOf(booked(), "out-high"))).toEqual([
      { kind: "booking", headline: BOOKING.headline, blurb: BOOKING.blurb },
    ]);
    const screen = screenFor(outcomeOf(booked(), "out-high"), booked());
    expect(screen.kind === "outcome" && screen.blocks.map((b) => b.kind)).toEqual(["booking"]);
  });
});
