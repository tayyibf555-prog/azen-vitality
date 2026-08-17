// "WRITE THIS FOR ME", held to the two promises that make it safe to ship:
//
//   IT NEVER RETURNS WORDING A PATIENT MAY NOT SEE. Not with a warning, not with
//   a flag, not once. A dirty line costs ONE regeneration and then the whole call
//   gives up with nothing.
//
//   IT NEVER WRITES A TESTIMONIAL, or a practice's name, whatever asks it to. The
//   rail draws no button there; this file proves the ENGINE refuses too, because
//   the rail is a keyboard and a keyboard is not a gate.
//
// Everything else here is the ordinary shape of a model seam in this codebase: a
// prompt that can be read, a parser that drops rather than truncates, a pipeline
// that never throws, and a landing path that is the SAME landing path a typed line
// takes (applyInspectorEdit -> flow-edit), which is why an AI line inherits every
// trim and every refusal without a line of code that knows where it came from.

import { describe, it, expect, vi } from "vitest";
import {
  ASSIST_FIELDS,
  ASSIST_TARGET_MOVED,
  assistBlockFieldRefusal,
  assistCopy,
  assistEditFor,
  assistFingerprint,
  assistMaxTokens,
  assistTargetKey,
  buildAssistPrompt,
  buildAssistRetryUser,
  canLandAssist,
  isAssistableBlockField,
  parseAssistReply,
  parseAssistTarget,
  resolveAssistTarget,
  type AssistTarget,
  type CallAssistModel,
} from "./flow-assist";
import { FLOW_LIMITS, type FlowBlock, type FlowGraph, type FlowNode } from "./flow";
import { templateForGoal } from "./flow-templates";
import {
  moveBlock,
  moveEdge,
  removeBlockItem,
  setOutcomeHeadline,
  type FlowEditResult,
} from "./flow-edit";
import { applyInspectorEdit, type FlowSelection } from "./flow-inspect";
import { validateFlow } from "./flow-validate";
import { scanFlowCopy } from "./flow-copy";
import { questionById } from "./quiz";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const base = (): FlowGraph => templateForGoal("invisalign").build();

const FAQ: FlowBlock = {
  kind: "faq",
  items: [
    { q: "How soon could I be seen?", a: "Usually within a week or so." },
    { q: "Will it hurt?", a: "The team will talk you through what to expect." },
  ],
};
const TESTIMONIAL: FlowBlock = {
  kind: "testimonial",
  quote: "The team looked after me from start to finish.",
  attribution: "Sam, Wood Green",
};
const TRUST: FlowBlock = { kind: "trust-strip", practiceName: "Vitality Dental", chips: ["Open Saturdays"] };

/** The template with blocks on the opening screen, in a known order. */
function withBlocks(blocks: FlowBlock[] = [FAQ, TESTIMONIAL, TRUST]): FlowGraph {
  const graph = base();
  return {
    ...graph,
    nodes: graph.nodes.map((n): FlowNode => (n.kind === "welcome" ? { ...n, blocks } : n)),
  };
}

/** An edit that must have been allowed, so an unexpected refusal names itself. */
function must(result: FlowEditResult): FlowGraph {
  if (!result.ok) throw new Error(`expected an edit, got: ${result.reason}`);
  return result.graph;
}

const firstQuestionId = (graph: FlowGraph): string =>
  graph.nodes.find((n): n is Extract<FlowNode, { kind: "question" }> => n.kind === "question")!.id;

/** A model that replies with whatever it is handed, one call at a time. */
function modelSaying(...replies: (string | { text: string; stopReason?: string | null })[]): {
  callModel: CallAssistModel;
  calls: { system: string; user: string; maxTokens: number }[];
} {
  const calls: { system: string; user: string; maxTokens: number }[] = [];
  let at = 0;
  const callModel: CallAssistModel = async (system, user, maxTokens) => {
    calls.push({ system, user, maxTokens });
    const reply = replies[Math.min(at++, replies.length - 1)]!;
    return typeof reply === "string" ? { text: reply, stopReason: "end_turn" } : { stopReason: "end_turn", ...reply };
  };
  return { callModel, calls };
}

// ---------------------------------------------------------------------------
// 1. WHICH BOX. Resolution is where every judgement about a target lives.
// ---------------------------------------------------------------------------

describe("resolveAssistTarget", () => {
  // MUTATION: resolve off the field name alone and a "headline" target naming a
  // question screen produces a prompt about a box that does not exist, whose
  // answer then lands nowhere.
  it("names the field, its cap and what is in it now", () => {
    const graph = base();
    const welcome = resolveAssistTarget(graph, { nodeId: "welcome", field: "headline" });
    expect(welcome.ok).toBe(true);
    if (!welcome.ok) return;
    expect(welcome.target.max).toBe(FLOW_LIMITS.headline);
    expect(welcome.target.current).toBe("");

    const outcome = resolveAssistTarget(graph, { nodeId: "result-high", field: "headline" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The template writes this one, so the model is rewriting rather than filling.
    expect(outcome.target.current).toBe("You look ready to get started.");
    expect(outcome.target.max).toBe(FLOW_LIMITS.headline);

    const intro = resolveAssistTarget(graph, { nodeId: "welcome", field: "intro" });
    expect(intro.ok && intro.target.max).toBe(FLOW_LIMITS.intro);
  });

  it("refuses a field the screen does not have", () => {
    const graph = base();
    const q = firstQuestionId(graph);
    expect(resolveAssistTarget(graph, { nodeId: q, field: "headline" }).ok).toBe(false);
    expect(resolveAssistTarget(graph, { nodeId: q, field: "intro" }).ok).toBe(false);
    expect(resolveAssistTarget(graph, { nodeId: "welcome", field: "transition" }).ok).toBe(false);
    expect(resolveAssistTarget(graph, { nodeId: "contact", field: "headline" }).ok).toBe(false);
    expect(resolveAssistTarget(graph, { nodeId: "not-a-step", field: "headline" }).ok).toBe(false);
  });

  // MUTATION: resolve an edge by index alone. The rail's button was pressed on ONE
  // step, and an index that has since come to name a wire out of a different step
  // would write that step's lead-in instead.
  it("holds an edge lead-in to a wire that still leaves this step", () => {
    const graph = base();
    const mine = graph.edges.findIndex((e) => e.from === "welcome");
    const theirs = graph.edges.findIndex((e) => e.from === "contact");
    expect(resolveAssistTarget(graph, { nodeId: "welcome", field: "edge-transition", index: mine }).ok).toBe(true);
    expect(resolveAssistTarget(graph, { nodeId: "welcome", field: "edge-transition", index: theirs }).ok).toBe(false);
    expect(resolveAssistTarget(graph, { nodeId: "welcome", field: "edge-transition", index: 999 }).ok).toBe(false);
    expect(resolveAssistTarget(graph, { nodeId: "welcome", field: "edge-transition" }).ok).toBe(false);
  });

  it("holds a block line to a line that block actually carries", () => {
    const graph = withBlocks();
    const ok = resolveAssistTarget(graph, {
      nodeId: "welcome",
      field: "block-text",
      index: 0,
      blockField: "items[1].a",
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.target.current).toBe("The team will talk you through what to expect.");
    expect(ok.target.max).toBe(FLOW_LIMITS.faqAnswer);

    for (const bad of [
      { index: 0, blockField: "quote" }, // a faq has no quote
      { index: 9, blockField: "items[0].q" }, // no such block
      { index: 0 }, // no field named
    ]) {
      expect(
        resolveAssistTarget(graph, { nodeId: "welcome", field: "block-text", ...bad }).ok,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE CHARTER, in the engine. The rail's disabled attribute is not the rule.
// ---------------------------------------------------------------------------

describe("what a model is never asked to write", () => {
  // MUTATION: allow the quote "because the owner asked for it". The charter is
  // absolute: a testimonial block renders only practice-entered quotes.
  it("refuses every line of a testimonial, in words", () => {
    const graph = withBlocks();
    for (const blockField of ["quote", "attribution"]) {
      const r = resolveAssistTarget(graph, { nodeId: "welcome", field: "block-text", index: 1, blockField });
      expect(r.ok, blockField).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain("nothing here writes one for you");
    }
    expect(isAssistableBlockField("testimonial", "quote")).toBe(false);
    expect(isAssistableBlockField("testimonial", "attribution")).toBe(false);
  });

  // MUTATION: let it write the practice's name. It is a FACT, and inventing one is
  // the same class of error as inventing a quote.
  it("refuses the practice's own name on a trust strip, but writes its chips", () => {
    expect(isAssistableBlockField("trust-strip", "practiceName")).toBe(false);
    expect(assistBlockFieldRefusal("trust-strip", "practiceName")).toContain("nothing here invents one");
    expect(isAssistableBlockField("trust-strip", "chips[0]")).toBe(true);
  });

  it("writes the ordinary furniture: faq, alt text, the booking line", () => {
    expect(isAssistableBlockField("faq", "items[0].q")).toBe(true);
    expect(isAssistableBlockField("image", "alt")).toBe(true);
    expect(isAssistableBlockField("booking", "headline")).toBe(true);
    expect(isAssistableBlockField("booking", "blurb")).toBe(true);
  });

  // MUTATION: build the prompt first and check the refusal after. A refused target
  // must have no prompt AT ALL, or the refusal is one forgotten call away from
  // being decorative.
  it("has no prompt for a refused target, and spends no model call on one", async () => {
    const graph = withBlocks();
    const target: AssistTarget = { nodeId: "welcome", field: "block-text", index: 1, blockField: "quote" };
    expect(buildAssistPrompt(target, graph)).toBeNull();

    const { callModel, calls } = modelSaying("Anything at all.");
    const result = await assistCopy({ target, graph, callModel });
    expect(calls).toHaveLength(0);
    expect(result.source).toBe("none");
    expect(result.reason).toBe("refused");
    expect(result.text).toBeNull();
    expect(result.message).toContain("nothing here writes one for you");
  });
});

// ---------------------------------------------------------------------------
// 3. THE PROMPT.
// ---------------------------------------------------------------------------

describe("buildAssistPrompt", () => {
  // MUTATION: drop the cap from the system prompt and the model writes a paragraph
  // for a 90-character box, which the parser then throws away - a spent call and a
  // refusal, every time.
  it("tells the model the one field, its cap, and the whole ban list", () => {
    const prompt = buildAssistPrompt({ nodeId: "welcome", field: "headline" }, base(), {
      practiceName: "Vitality Dental",
    });
    expect(prompt).not.toBeNull();
    if (!prompt) return;
    expect(prompt.system).toContain("the opening headline");
    expect(prompt.system).toContain(`At most ${FLOW_LIMITS.headline} characters`);
    for (const banned of ["NHS", "prices", "guarantees", "reviews", "clinical advice", "dashes"]) {
      expect(prompt.system, `the prompt does not ban ${banned}`).toContain(banned);
    }
    // Rule 1 is what makes parseAssistReply's job small.
    expect(prompt.system).toContain("no JSON");
    expect(prompt.user).toContain("Vitality Dental");
  });

  // MUTATION: send the field on its own. A lead-in written without the question it
  // leads into is a sentence about nothing.
  it("carries the question a lead-in leads into, with its answers", () => {
    const graph = base();
    const id = firstQuestionId(graph);
    const node = graph.nodes.find((n) => n.id === id) as Extract<FlowNode, { kind: "question" }>;
    const q = questionById(node.questionId)!;
    const prompt = buildAssistPrompt({ nodeId: id, field: "transition" }, graph);
    expect(prompt?.user).toContain(q.prompt);
    expect(prompt?.user).toContain(q.options[0]!.label);
  });

  it("carries the answer and the destination for a connection's lead-in", () => {
    const graph = base();
    const index = graph.edges.findIndex((e) => e.from !== "welcome" && e.answer !== null);
    const edge = graph.edges[index]!;
    const prompt = buildAssistPrompt({ nodeId: edge.from, field: "edge-transition", index }, graph);
    expect(prompt).not.toBeNull();
    expect(prompt!.user).toContain("It is shown to a patient who answered");
    expect(prompt!.user).toContain("They are arriving at");
  });

  // MUTATION: leave the result screen's own rule out. Score bands are about how
  // ready the ENQUIRY is; a headline that implies a treatment would suit them is
  // the one clinical claim this screen invites.
  it("tells a result headline it is about the enquiry, never the treatment", () => {
    const prompt = buildAssistPrompt({ nodeId: "result-high", field: "headline" }, base());
    expect(prompt?.user).toContain("never about what treatment would suit");
    expect(prompt?.user).toContain("You look ready to get started.");
  });

  it("says how far into the funnel the screen is", () => {
    const graph = base();
    expect(buildAssistPrompt({ nodeId: "welcome", field: "headline" }, graph)?.user).toContain(
      "Questions already answered before this screen: 0",
    );
    const contactAt = buildAssistPrompt({ nodeId: "result-high", field: "headline" }, graph)?.user ?? "";
    expect(/Questions already answered before this screen: [1-9]/.test(contactAt)).toBe(true);
  });

  it("quotes the offending phrase, and the original brief, on the one retry", () => {
    const retry = buildAssistRetryUser("THE BRIEF", "We are the best on the NHS.", [
      { where: "", category: "jargon", matched: "NHS" },
    ]);
    expect(retry).toContain("THE BRIEF");
    expect(retry).toContain("We are the best on the NHS.");
    expect(retry).toContain("“NHS” is not allowed");
  });
});

// ---------------------------------------------------------------------------
// 4. READING THE REPLY.
// ---------------------------------------------------------------------------

describe("parseAssistReply", () => {
  it("takes the line, and only the line", () => {
    expect(parseAssistReply("Let us start with what you would change.", 90)).toBe(
      "Let us start with what you would change.",
    );
    expect(parseAssistReply('  "Tell us what you would change."  ', 90)).toBe(
      "Tell us what you would change.",
    );
    expect(parseAssistReply("```\nTell us more.\n```", 90)).toBe("Tell us more.");
    // Rule 1 broken: three options offered. The first is the model's own best.
    expect(parseAssistReply("Ready when you are.\nOr: Let us begin.\nOr: Start here.", 90)).toBe(
      "Ready when you are.",
    );
  });

  // MUTATION: replace the dash character alone and "Great — when suits you?"
  // becomes "Great , when suits you?" in front of a patient.
  it("takes the spaces around a dash with it", () => {
    expect(parseAssistReply("Great — when suits you?", 90)).toBe("Great, when suits you?");
    expect(parseAssistReply("Nearly there – one more.", 90)).toBe("Nearly there, one more.");
    expect(parseAssistReply("Almost done —", 90)).toBe("Almost done");
  });

  // MUTATION: truncate instead of dropping. Half a sentence in a headline box is
  // worse than the words the owner already had.
  it("drops an overlong line rather than cutting it", () => {
    const long = "x".repeat(120);
    expect(parseAssistReply(long, 90)).toBeNull();
    expect(parseAssistReply(long, 240)).toBe(long);
  });

  it("has nothing to say about an empty reply", () => {
    expect(parseAssistReply("", 90)).toBeNull();
    expect(parseAssistReply("   \n  \n", 90)).toBeNull();
    expect(parseAssistReply('""', 90)).toBeNull();
  });
});

describe("assistMaxTokens", () => {
  // MUTATION: pass the funnel writer's 3000. Every one of these calls is a BUTTON
  // an owner presses dozens of times a session, and a cap ten times the field's
  // size only pays for a model that ignored rule 1.
  it("is sized to the field, never to a funnel", () => {
    for (const cap of [FLOW_LIMITS.headline, FLOW_LIMITS.transition, FLOW_LIMITS.intro, FLOW_LIMITS.quote]) {
      const tokens = assistMaxTokens(cap);
      expect(tokens).toBeLessThanOrEqual(300);
      // ...and never so small that a legal line cannot fit: ~3 characters a token.
      expect(tokens).toBeGreaterThan(cap / 3);
    }
    expect(assistMaxTokens(9000)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// 5. THE PIPELINE.
// ---------------------------------------------------------------------------

describe("assistCopy", () => {
  const graph = base();
  const HEADLINE: AssistTarget = { nodeId: "welcome", field: "headline" };

  it("returns the line, once it passes the scan", async () => {
    const { callModel, calls } = modelSaying("Let us find out what you would change.");
    const result = await assistCopy({ target: HEADLINE, graph, callModel });
    expect(result).toEqual({
      text: "Let us find out what you would change.",
      source: "model",
      reason: null,
      message: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.maxTokens).toBe(assistMaxTokens(FLOW_LIMITS.headline));
  });

  // MUTATION: parse a truncated reply anyway. It is not a line with a word
  // missing, it is a sentence that stops.
  it("refuses a truncated reply before parsing it, and does not retry", async () => {
    const { callModel, calls } = modelSaying({ text: "Let us find out what you", stopReason: "max_tokens" });
    const result = await assistCopy({ target: HEADLINE, graph, callModel });
    expect(result.text).toBeNull();
    expect(result.reason).toBe("truncated");
    expect(calls).toHaveLength(1);
  });

  // MUTATION: return the dirty line with a warning. The rail would then hold
  // wording a patient must not see, in a box the owner may never re-read.
  it("regenerates ONCE on a scan hit, and returns the clean second line", async () => {
    const { callModel, calls } = modelSaying(
      "The best NHS smile in London.",
      "Tell us what you would change about your smile.",
    );
    const result = await assistCopy({ target: HEADLINE, graph, callModel });
    expect(result.source).toBe("model");
    expect(result.text).toBe("Tell us what you would change about your smile.");
    expect(calls).toHaveLength(2);
    // The retry quotes the phrase that failed, not a generic scolding.
    expect(calls[1]!.user).toContain("NHS");
  });

  it("gives up with nothing when the second line is dirty too", async () => {
    const { callModel, calls } = modelSaying("The best NHS smile.", "Our pain free private care.");
    const result = await assistCopy({ target: HEADLINE, graph, callModel });
    expect(result.source).toBe("none");
    expect(result.reason).toBe("non-compliant");
    expect(result.text).toBeNull();
    expect(result.message).toContain("write this one yourself");
    // TWO calls, never three: a second dirty line is a model that will not write
    // this field, and a third call buys nothing but the bill.
    expect(calls).toHaveLength(2);
  });

  it("never returns a line that fails the scan, whatever the model says", async () => {
    for (const dirty of [
      "The best NHS dentist in London.",
      "Guaranteed pain free treatment.",
      "Our private patients love us.",
      "Rated 5 stars by every patient.",
    ]) {
      const { callModel } = modelSaying(dirty, dirty);
      const result = await assistCopy({ target: HEADLINE, graph, callModel });
      expect(result.text, dirty).toBeNull();
      expect(result.source, dirty).toBe("none");
    }
  });

  // MUTATION: add a repair pass for an unreadable line. There is nothing to say to
  // the model that the first prompt did not already say.
  it("gives up on an unreadable or overlong line without a second call", async () => {
    for (const reply of ["", "x".repeat(200)]) {
      const { callModel, calls } = modelSaying(reply);
      const result = await assistCopy({ target: HEADLINE, graph, callModel });
      expect(result.reason).toBe("unreadable");
      expect(result.text).toBeNull();
      expect(calls).toHaveLength(1);
    }
  });

  it("never throws: a model or network error is a line that did not arrive", async () => {
    const callModel = vi.fn(async () => {
      throw new Error("upstream 529");
    }) as unknown as CallAssistModel;
    const result = await assistCopy({ target: HEADLINE, graph, callModel });
    expect(result.source).toBe("none");
    expect(result.reason).toBe("model-error");
    expect(result.message).toContain("exactly as it was");
  });

  it("writes every field the rail offers", async () => {
    const withBlock = withBlocks([FAQ]);
    const q = firstQuestionId(withBlock);
    const edgeIndex = withBlock.edges.findIndex((e) => e.from === q);
    const targets: AssistTarget[] = [
      { nodeId: "welcome", field: "headline" },
      { nodeId: "welcome", field: "intro" },
      { nodeId: q, field: "transition" },
      { nodeId: q, field: "edge-transition", index: edgeIndex },
      { nodeId: "welcome", field: "block-text", index: 0, blockField: "items[0].a" },
      { nodeId: "result-high", field: "headline" },
    ];
    for (const target of targets) {
      const { callModel } = modelSaying("Tell us what you would like to change.");
      const result = await assistCopy({ target, graph: withBlock, callModel });
      expect(result.source, JSON.stringify(target)).toBe("model");
    }
    // Every field the union names is covered above.
    expect(new Set(targets.map((t) => t.field))).toEqual(new Set(ASSIST_FIELDS));
  });
});

// ---------------------------------------------------------------------------
// 6. LANDING IT. The same path a typed line takes, and no other.
// ---------------------------------------------------------------------------

describe("assistEditFor", () => {
  // MUTATION: write the line onto the graph here. Every trim, every refusal and
  // every "this screen has no such box" lives in flow-edit; a second landing path
  // is a second set of rules to keep in step.
  it("lands each field through the ordinary edit intent, trimmed by flow-edit", () => {
    const graph = withBlocks([FAQ]);
    const q = firstQuestionId(graph);
    const edgeIndex = graph.edges.findIndex((e) => e.from === q);

    const cases: { target: AssistTarget; selection: FlowSelection; read: (g: FlowGraph) => string | undefined }[] = [
      {
        target: { nodeId: "welcome", field: "headline" },
        selection: { kind: "node", id: "welcome" },
        read: (g) => (g.nodes.find((n) => n.id === "welcome") as Extract<FlowNode, { kind: "welcome" }>).headline,
      },
      {
        target: { nodeId: "welcome", field: "intro" },
        selection: { kind: "node", id: "welcome" },
        read: (g) => (g.nodes.find((n) => n.id === "welcome") as Extract<FlowNode, { kind: "welcome" }>).intro,
      },
      {
        target: { nodeId: q, field: "transition" },
        selection: { kind: "node", id: q },
        read: (g) => (g.nodes.find((n) => n.id === q) as Extract<FlowNode, { kind: "question" }>).transition,
      },
      {
        target: { nodeId: q, field: "edge-transition", index: edgeIndex },
        selection: { kind: "edge", index: edgeIndex },
        read: (g) => g.edges[edgeIndex]!.transition,
      },
      {
        target: { nodeId: "result-high", field: "headline" },
        selection: { kind: "node", id: "result-high" },
        read: (g) => (g.nodes.find((n) => n.id === "result-high") as Extract<FlowNode, { kind: "outcome" }>).headline,
      },
      {
        target: { nodeId: "welcome", field: "block-text", index: 0, blockField: "items[0].q" },
        selection: { kind: "node", id: "welcome" },
        read: (g) => {
          const node = g.nodes.find((n) => n.id === "welcome") as Extract<FlowNode, { kind: "welcome" }>;
          const block = node.blocks![0]!;
          return block.kind === "faq" ? block.items[0]!.q : undefined;
        },
      },
    ];

    for (const { target, selection, read } of cases) {
      const edit = assistEditFor(target, "A line the model wrote.");
      expect(edit, JSON.stringify(target)).not.toBeNull();
      const result = applyInspectorEdit(graph, selection, edit!);
      expect(result.ok, JSON.stringify(target)).toBe(true);
      if (!result.ok) continue;
      expect(read(result.graph)).toBe("A line the model wrote.");
      // A landed line leaves a funnel that still validates and still scans clean.
      expect(validateFlow(result.graph).ok).toBe(true);
      expect(scanFlowCopy(result.graph)).toEqual([]);
    }
  });

  it("is trimmed to the field's cap by the op, not by the writer", () => {
    const graph = base();
    const edit = assistEditFor({ nodeId: "welcome", field: "headline" }, "y".repeat(400));
    const result = applyInspectorEdit(graph, { kind: "node", id: "welcome" }, edit!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.graph.nodes.find((n) => n.id === "welcome") as Extract<FlowNode, { kind: "welcome" }>;
    expect(node.headline).toHaveLength(FLOW_LIMITS.headline);
  });

  it("has no intent for a target missing the index it needs", () => {
    expect(assistEditFor({ nodeId: "welcome", field: "edge-transition" }, "x")).toBeNull();
    expect(assistEditFor({ nodeId: "welcome", field: "block-text", index: 0 }, "x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. THE FUNNEL MOVES WHILE THE LINE IS BEING WRITTEN.
// ---------------------------------------------------------------------------

describe("canLandAssist", () => {
  // MUTATION: land it regardless. `headline` acts on WHATEVER IS SELECTED, so an
  // opening headline would be written onto a result screen because the owner
  // clicked away during the second the model took - silently, with the save
  // reporting success.
  it("refuses a node-scoped line once the selection has moved", () => {
    const graph = base();
    const target: AssistTarget = { nodeId: "welcome", field: "headline" };
    expect(canLandAssist(graph, { kind: "node", id: "welcome" }, target)).toBe(true);
    expect(canLandAssist(graph, { kind: "node", id: "result-high" }, target)).toBe(false);
    expect(canLandAssist(graph, null, target)).toBe(false);
    expect(canLandAssist(graph, { kind: "edge", index: 0 }, target)).toBe(false);
    expect(ASSIST_TARGET_MOVED).toContain("Nothing was changed");
  });

  // An edge intent carries its own index and is valid from either selection, so
  // only the wire has to still be the one the button was pressed on.
  it("lands a connection's line from either selection, while the wire is still there", () => {
    const graph = base();
    const index = graph.edges.findIndex((e) => e.from === "welcome");
    const target: AssistTarget = { nodeId: "welcome", field: "edge-transition", index };
    expect(canLandAssist(graph, { kind: "edge", index }, target)).toBe(true);
    expect(canLandAssist(graph, { kind: "node", id: "result-high" }, target)).toBe(true);
    // ...and the wire really is checked: an index that now leaves another step is
    // not this button's wire any more.
    const moved: FlowGraph = { ...graph, edges: graph.edges.filter((e) => e.from !== "welcome") };
    expect(canLandAssist(moved, { kind: "edge", index }, target)).toBe(false);
  });

  it("refuses a block line once that block has gone", () => {
    const graph = withBlocks([FAQ]);
    const target: AssistTarget = { nodeId: "welcome", field: "block-text", index: 0, blockField: "items[0].q" };
    expect(canLandAssist(graph, { kind: "node", id: "welcome" }, target)).toBe(true);
    expect(canLandAssist(base(), { kind: "node", id: "welcome" }, target)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7b. THE FUNNEL MOVES *UNDER* THE LINE: an index is an address, not an identity.
// ---------------------------------------------------------------------------

describe("assistFingerprint closes the reorder race", () => {
  /** A second faq, so the screen holds two blocks with the SAME field names. */
  const FAQ_TWO: FlowBlock = {
    kind: "faq",
    items: [
      { q: "Where do I park?", a: "There are spaces at the back of the practice." },
      { q: "Can I bring someone?", a: "Yes, you are very welcome to." },
    ],
  };

  // THE CONFIRMED DEFECT, IN ONE TEST.
  //
  // canLandAssist used to ask the RESOLVER whether the target still fitted, and
  // the resolver answers about shape: is there a block at index 1 on this screen
  // with a line called `items[0].q`. Move the block up while the model is writing -
  // the two arrow buttons sit directly beside the "write this for me" button on
  // every block card - and the answer is still yes, about a DIFFERENT BLOCK. The
  // line then lands on somebody else's words, and the save reports success.
  //
  // Two blocks of one kind is what makes it visible rather than lucky: field names
  // happen not to collide across today's five kinds, so a swap is usually caught by
  // a missing field rather than by anything that meant to catch it. A draft on the
  // canvas can hold two (normaliseFlow is shape-only; rule 12's duplicate-kind
  // refusal is a SAVE-time gate), and `booking` already shares the name `headline`
  // with a node's own field.
  //
  // MUTATION: drop the `target.at` line from canLandAssist and this goes red while
  // every other refusal in this file stays green.
  it("refuses when the block is moved up beside the button", () => {
    const graph = withBlocks([FAQ, FAQ_TWO]);
    const at = assistFingerprint(graph, {
      nodeId: "welcome",
      field: "block-text",
      index: 1,
      blockField: "items[0].q",
    });
    expect(at).not.toBeNull();
    const target: AssistTarget = {
      nodeId: "welcome",
      field: "block-text",
      index: 1,
      blockField: "items[0].q",
      at: at!,
    };
    const selection: FlowSelection = { kind: "node", id: "welcome" };
    expect(canLandAssist(graph, selection, target)).toBe(true);

    // The owner presses "move up" on that block while the line is being written.
    const moved = must(moveBlock(graph, "welcome", 1, -1));
    // The shape still fits - which is exactly why the shape was never enough.
    expect(resolveAssistTarget(moved, target).ok).toBe(true);
    expect(canLandAssist(moved, selection, target)).toBe(false);
  });

  it("refuses when the block is moved down beside the button", () => {
    const graph = withBlocks([FAQ, FAQ_TWO]);
    const target: AssistTarget = {
      nodeId: "welcome",
      field: "block-text",
      index: 0,
      blockField: "items[1].a",
    };
    const stamped: AssistTarget = { ...target, at: assistFingerprint(graph, target)! };
    const selection: FlowSelection = { kind: "node", id: "welcome" };
    expect(canLandAssist(graph, selection, stamped)).toBe(true);

    const moved = must(moveBlock(graph, "welcome", 0, 1));
    expect(resolveAssistTarget(moved, stamped).ok).toBe(true);
    expect(canLandAssist(moved, selection, stamped)).toBe(false);
  });

  // The same failure without a second block: deleting an faq item from ABOVE the
  // one being written slides every later item up one, so `items[1].a` is a
  // different answer to a different question, with nothing missing to notice.
  it("refuses when an faq item above the target is deleted", () => {
    const THREE: FlowBlock = {
      kind: "faq",
      items: [
        { q: "Where do I park?", a: "There are spaces at the back." },
        { q: "Will it hurt?", a: "The team will talk you through what to expect." },
        { q: "How soon?", a: "Usually within a week or so." },
      ],
    };
    const graph = withBlocks([THREE]);
    const target: AssistTarget = {
      nodeId: "welcome",
      field: "block-text",
      index: 0,
      blockField: "items[1].a",
    };
    const stamped: AssistTarget = { ...target, at: assistFingerprint(graph, target)! };
    const selection: FlowSelection = { kind: "node", id: "welcome" };
    expect(canLandAssist(graph, selection, stamped)).toBe(true);

    const trimmed = must(removeBlockItem(graph, "welcome", 0, 0));
    expect(resolveAssistTarget(trimmed, stamped).ok).toBe(true);
    expect(canLandAssist(trimmed, selection, stamped)).toBe(false);
  });

  // An edge lead-in addresses itself by index too, and the resolver only checks
  // that the wire still LEAVES THIS STEP - which every sibling branch does. Reorder
  // the answers with the move buttons and the index sits on a different branch off
  // the same question: the line written for "I am still deciding" is then shown to
  // whoever said "as soon as possible". Same step, wrong answer, nothing missing.
  it("refuses when the answers off the same step are reordered", () => {
    const graph = base();
    const from = firstQuestionId(graph);
    const branches = graph.edges.filter((e) => e.from === from);
    // Only worth asserting on a step that really has more than one wire.
    expect(branches.length).toBeGreaterThan(1);
    const index = graph.edges.findIndex((e) => e === branches[1]);
    const target: AssistTarget = { nodeId: from, field: "edge-transition", index };
    const stamped: AssistTarget = { ...target, at: assistFingerprint(graph, target)! };
    expect(canLandAssist(graph, { kind: "edge", index }, stamped)).toBe(true);

    const reordered = must(moveEdge(graph, index, -1));
    // The wire at that index still leaves this step, so the resolver is content...
    expect(resolveAssistTarget(reordered, stamped).ok).toBe(true);
    // ...and it is a different answer, which is what the fingerprint is for.
    expect(canLandAssist(reordered, { kind: "edge", index }, stamped)).toBe(false);
  });

  // The other half of "identity, not shape": nothing moved, so the line lands.
  // Without this the fix could be `return false` and every test above would pass.
  it("lands when nothing under the target has changed", () => {
    const graph = withBlocks([FAQ, FAQ_TWO]);
    const target: AssistTarget = {
      nodeId: "welcome",
      field: "block-text",
      index: 1,
      blockField: "items[0].q",
    };
    const stamped: AssistTarget = { ...target, at: assistFingerprint(graph, target)! };
    // A fresh copy of the same funnel: equal content, different objects.
    expect(canLandAssist(withBlocks([FAQ, FAQ_TWO]), { kind: "node", id: "welcome" }, stamped)).toBe(
      true,
    );
    // ...and an edit somewhere else in the funnel does not refuse it.
    const elsewhere = must(setOutcomeHeadline(graph, "result-high", "A plan you can picture"));
    expect(canLandAssist(elsewhere, { kind: "node", id: "welcome" }, stamped)).toBe(true);
  });

  // A target the funnel no longer holds has no fingerprint to compare, and the
  // builder treats that as "the box is gone" rather than as "skip the check".
  it("has no fingerprint for a target that does not resolve", () => {
    expect(assistFingerprint(base(), { nodeId: "nowhere", field: "headline" })).toBeNull();
    expect(
      assistFingerprint(base(), { nodeId: "welcome", field: "block-text", index: 0, blockField: "alt" }),
    ).toBeNull();
  });

  // The owner gave up waiting and typed. The line was written for the box as it
  // was, and arrives to find different words in it: refuse rather than overwrite
  // them. Costing one more press is the cheaper of the two mistakes.
  it("refuses once the owner has typed in the box themselves", () => {
    const graph = base();
    const target: AssistTarget = { nodeId: "result-high", field: "headline" };
    const stamped: AssistTarget = { ...target, at: assistFingerprint(graph, target)! };
    const selection: FlowSelection = { kind: "node", id: "result-high" };
    expect(canLandAssist(graph, selection, stamped)).toBe(true);

    const typed = must(setOutcomeHeadline(graph, "result-high", "A plan you can picture"));
    expect(canLandAssist(typed, selection, stamped)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. THE WIRE FORMAT: what a rail sends and a route reads.
// ---------------------------------------------------------------------------

describe("the target on the wire", () => {
  it("keys two buttons apart, including two blocks with a field of the same name", () => {
    const a = assistTargetKey({ nodeId: "welcome", field: "block-text", index: 0, blockField: "alt" });
    const b = assistTargetKey({ nodeId: "welcome", field: "block-text", index: 1, blockField: "alt" });
    expect(a).not.toBe(b);
    expect(assistTargetKey({ nodeId: "welcome", field: "headline" })).toBe(
      assistTargetKey({ nodeId: "welcome", field: "headline" }),
    );
  });

  // MUTATION: trust the body. This is the shape a route reads off the wire, so a
  // hostile field name or a fractional index must not reach the resolver.
  it("reads a target off a body, and refuses anything else", () => {
    expect(parseAssistTarget({ nodeId: "welcome", field: "headline" })).toEqual({
      nodeId: "welcome",
      field: "headline",
    });
    expect(
      parseAssistTarget({ nodeId: "welcome", field: "block-text", index: 2, blockField: "items[0].a" }),
    ).toEqual({ nodeId: "welcome", field: "block-text", index: 2, blockField: "items[0].a" });

    for (const bad of [
      null,
      "welcome",
      [],
      {},
      { nodeId: "", field: "headline" },
      { nodeId: "welcome" },
      { nodeId: "welcome", field: "everything" },
      { nodeId: "x".repeat(FLOW_LIMITS.nodeId + 1), field: "headline" },
    ]) {
      expect(parseAssistTarget(bad), JSON.stringify(bad)).toBeNull();
    }
    // A nonsense index is dropped, and the resolver then refuses the target for
    // the field that needed one - rather than reading edges[-1].
    expect(parseAssistTarget({ nodeId: "welcome", field: "edge-transition", index: -1 })).toEqual({
      nodeId: "welcome",
      field: "edge-transition",
    });
    expect(parseAssistTarget({ nodeId: "welcome", field: "edge-transition", index: 1.5 })).toEqual({
      nodeId: "welcome",
      field: "edge-transition",
    });
  });
});
