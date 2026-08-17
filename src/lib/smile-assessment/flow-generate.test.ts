// THE GENERATOR'S CONTRACT, under adversarial replies.
//
// The Anthropic seam is the injected `callModel`, so every test below runs the
// REAL pipeline - prompt build, parse, assemble, validate, pin, compliance scan,
// repair, fallback - with no network and no SDK (the area16-next-route.test.ts
// pattern, one layer lower).
//
// What is being pinned here, in order of how much it would cost to get wrong:
//   1. Nothing unvalidated is ever returned, whatever the model says.
//   2. The contact step and the result copy are ours, not the model's.
//   3. A truncated reply is refused BEFORE it is parsed.
//   4. Exactly ONE repair pass. Not zero (a fixable funnel thrown away), not two
//      (a doubled bill on an endpoint an owner can hold down).
//   5. No funding jargon reaches a patient, even on the model's second attempt.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { validateFlow } from "./flow-validate";
import { templateForGoal } from "./flow-templates";
import { scanFlowCopy } from "./flow-copy";
import { Q_TIMELINE, questionById } from "./quiz";
import {
  FLOW_BLOCK_KINDS,
  withRequiredSchemaVersion,
  type FlowBlock,
  type FlowGraph,
  type FlowNode,
} from "./flow";
import {
  UNWRITABLE_BLOCK_KINDS,
  WRITABLE_BLOCK_KINDS,
  applyRewrittenCopy,
  buildFlowPrompt,
  buildRewritePrompt,
  generateFlow,
  parseFlowReply,
  pinScaffoldNodes,
  renderQuestionBank,
  sameFlowStructure,
  stripFlowCopy,
  type FlowModelReply,
} from "./flow-generate";

const HERE = dirname(fileURLToPath(import.meta.url));
const generateSource = readFileSync(join(HERE, "flow-generate.ts"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures: replies a model plausibly sends.
// ---------------------------------------------------------------------------

interface ReplyNode {
  id: string;
  questionId: string;
  transition?: string;
}
interface ReplyEdge {
  from: string;
  to: string;
  answer?: string | null;
  transition?: string;
}

function reply(nodes: ReplyNode[], edges: ReplyEdge[], entry = nodes[0]!.id): string {
  return JSON.stringify({ entry, nodes, edges });
}

/** A funnel a well-behaved model returns for an aligner campaign. */
const GOOD_NODES: ReplyNode[] = [
  { id: "n1", questionId: "treatment_interest" },
  { id: "n2", questionId: "smile_concern", transition: "Thank you. A quick one about your smile." },
  { id: "n3", questionId: "timeline", transition: "Lovely. When would you like to start?" },
  { id: "n4", questionId: "budget_readiness" },
  { id: "n5", questionId: "readiness" },
  { id: "n6", questionId: "location", transition: "Last one, so we can point you to the right practice." },
];
const GOOD_EDGES: ReplyEdge[] = [
  { from: "n1", to: "n2", answer: "invisalign" },
  { from: "n1", to: "n3", answer: null },
  { from: "n2", to: "n3", answer: null },
  { from: "n3", to: "n4", answer: null },
  { from: "n4", to: "n5", answer: null },
  { from: "n5", to: "n6", answer: null },
  { from: "n6", to: "contact", answer: null },
];
const GOOD = reply(GOOD_NODES, GOOD_EDGES);

/** Two failures at once: a question that is not in the bank, and no region step. */
const BAD = reply(
  [
    { id: "n1", questionId: "treatment_interest" },
    { id: "n2", questionId: "how_much_can_you_afford" },
    { id: "n3", questionId: "timeline" },
    { id: "n4", questionId: "budget_readiness" },
  ],
  [
    { from: "n1", to: "n2", answer: null },
    { from: "n2", to: "n3", answer: null },
    { from: "n3", to: "n4", answer: null },
    { from: "n4", to: "contact", answer: null },
  ],
);

/** Structurally perfect, but one transition carries forbidden funding jargon. */
const JARGON = reply(
  GOOD_NODES.map((n) =>
    n.id === "n4" ? { ...n, transition: "Next, whether you are NHS or private with us." } : n,
  ),
  GOOD_EDGES,
);

/** A stubbed model: one reply per call, in order. */
function stub(...replies: (string | FlowModelReply)[]) {
  const calls: { system: string; user: string }[] = [];
  let i = 0;
  const callModel = vi.fn(async (system: string, user: string): Promise<FlowModelReply> => {
    calls.push({ system, user });
    const next = replies[Math.min(i, replies.length - 1)]!;
    i += 1;
    return typeof next === "string" ? { text: next, stopReason: "end_turn" } : next;
  });
  return { callModel, calls };
}

function run(overrides: Partial<Parameters<typeof generateFlow>[0]> & { callModel: Parameters<typeof generateFlow>[0]["callModel"] }) {
  return generateFlow({ goal: "invisalign", idealCustomer: "adults in their 30s", targetBudget: "finance", ...overrides });
}

/** Every option of the timeline question, pictured with real manifest keys. */
const TIMELINE_PICTURES = questionById(Q_TIMELINE)!.options.map((o, i) => ({
  value: o.value,
  image: ["conditions/crowded", "conditions/gaps", "conditions/overbite", "conditions/underbite"][i]!,
}));

/**
 * The general template with its timeline question fully pictured, and its lead-in
 * set to whatever the caller asks for - including NOTHING, which is the branch
 * that matters most (see the pin below).
 */
function picturedTimeline(transition: string | undefined): FlowGraph {
  const template = templateForGoal("general").build();
  return withRequiredSchemaVersion({
    ...template,
    nodes: template.nodes.map((n) => {
      if (n.id !== `q-${Q_TIMELINE}` || n.kind !== "question") return n;
      const node: FlowNode = {
        id: n.id,
        kind: "question",
        questionId: n.questionId,
        optionImages: TIMELINE_PICTURES,
      };
      if (transition) node.transition = transition;
      return node;
    }),
  });
}

function transitionsOf(graph: FlowGraph): string[] {
  return [
    ...graph.nodes.flatMap((n) => (n.kind === "question" && n.transition ? [n.transition] : [])),
    ...graph.edges.flatMap((e) => (e.transition ? [e.transition] : [])),
  ];
}

// ---------------------------------------------------------------------------

describe("generateFlow — the happy path", () => {
  it("turns a well-formed reply into a VALID funnel in one call", async () => {
    const { callModel } = stub(GOOD);
    const out = await run({ callModel });

    expect(out.source).toBe("model");
    expect(out.reason).toBeNull();
    expect(validateFlow(out.graph).ok).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    // The model's questions are what it asked for, in the bank.
    expect(out.graph.nodes.filter((n) => n.kind === "question").map((n) => n.id)).toEqual([
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
      "n6",
    ]);
  });

  it("keeps the model's warm transition lines", async () => {
    const { callModel } = stub(GOOD);
    const out = await run({ callModel });
    expect(transitionsOf(out.graph)).toContain("Lovely. When would you like to start?");
  });
});

describe("generateFlow — the bank is the only source of questions", () => {
  it("rejects a questionId that is not in the bank and quotes it back", async () => {
    const { callModel, calls } = stub(BAD, BAD);
    const out = await run({ callModel });

    expect(out.source).toBe("template");
    expect(out.failures.some((f) => f.code === "unknown_question")).toBe(true);
    // The repair pass must quote EVERY failure, not just the first: this reply
    // has both an invented question and no region step.
    expect(calls[1]!.user).toContain("unknown_question");
    expect(calls[1]!.user).toContain("location_missing");
  });

  it("never puts option weights (the scoring model) in the prompt", () => {
    const bank = renderQuestionBank();
    expect(bank).not.toMatch(/weight/i);
    expect(bank).toContain("treatment_interest | treatment |");
    expect(bank).toContain("options: invisalign=");
    // The branch constraint must reach the model or rule 9 fails every time.
    expect(bank).toContain("ONLY after treatment_interest is answered implants");
  });
});

describe("generateFlow — exactly one repair pass", () => {
  it("repairs ONCE and uses a good second reply", async () => {
    const { callModel } = stub(BAD, GOOD);
    const out = await run({ callModel });

    expect(out.source).toBe("model-repair");
    expect(validateFlow(out.graph).ok).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("falls back to the GOAL's template when the second reply is still invalid", async () => {
    const { callModel } = stub(BAD, BAD);
    const out = await generateFlow({ goal: "implants", callModel });

    expect(out.source).toBe("template");
    expect(out.reason).toBe("invalid");
    expect(out.graph).toEqual(templateForGoal("implants").build());
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("falls back to the general template for a goal that has none", async () => {
    const { callModel } = stub(BAD, BAD);
    const out = await generateFlow({ goal: "not-a-goal", callModel });
    expect(out.graph).toEqual(templateForGoal("general").build());
  });
});

describe("generateFlow — a truncated reply is refused before parsing", () => {
  it("ignores a PERFECTLY GOOD funnel when stop_reason is max_tokens, and does not retry", async () => {
    // The text below would validate. It is refused anyway: a reply that hit the
    // cap is half-written by definition, and what looks complete here is exactly
    // how a mangled funnel gets stored.
    const { callModel } = stub({ text: GOOD, stopReason: "max_tokens" });
    const out = await run({ callModel });

    expect(out.source).toBe("template");
    expect(out.reason).toBe("truncated");
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("refuses a truncated REPAIR reply too", async () => {
    const { callModel } = stub(BAD, { text: GOOD, stopReason: "max_tokens" });
    const out = await run({ callModel });
    expect(out.source).toBe("template");
    expect(out.reason).toBe("truncated");
    expect(callModel).toHaveBeenCalledTimes(2);
  });
});

describe("generateFlow — an unusable reply never throws", () => {
  it("survives prose with no JSON in it", async () => {
    const { callModel } = stub("I am sorry, I cannot design funnels.", "Still prose.");
    const out = await run({ callModel });
    expect(out.source).toBe("template");
    expect(out.reason).toBe("unreadable");
    expect(validateFlow(out.graph).ok).toBe(true);
  });

  it("survives JSON that is not a funnel at all", async () => {
    const { callModel } = stub('{"questions":["timeline"]}', "[]");
    const out = await run({ callModel });
    expect(out.source).toBe("template");
    expect(validateFlow(out.graph).ok).toBe(true);
  });

  it("survives a model that throws", async () => {
    const callModel = vi.fn(async () => {
      throw new Error("upstream 529");
    });
    const out = await run({ callModel });
    expect(out.source).toBe("template");
    expect(out.reason).toBe("model-error");
    expect(validateFlow(out.graph).ok).toBe(true);
  });

  it("drops junk nodes rather than failing the parse outright", () => {
    const parsed = parseFlowReply(
      JSON.stringify({
        entry: "n1",
        nodes: [{ id: "n1", questionId: "timeline" }, 42, { id: "n2" }, { kind: "outcome", band: "high" }],
        edges: [{ from: "n1", to: "contact" }, "nonsense"],
      }),
    );
    expect(parsed!.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(parsed!.edges).toEqual([{ from: "n1", to: "contact", answer: null }]);
  });
});

describe("generateFlow — the contact step and the results are pinned", () => {
  it("adds exactly one contact step and three results, none of them the model's", async () => {
    const { callModel } = stub(GOOD);
    const out = await run({ callModel });
    const template = templateForGoal("invisalign").build();

    expect(out.graph.nodes.filter((n) => n.kind === "contact")).toHaveLength(1);
    expect(out.graph.nodes.filter((n) => n.kind === "outcome")).toEqual(
      template.nodes.filter((n) => n.kind === "outcome"),
    );
  });

  it("drops a model edge out of the contact step: the band routes are ours", async () => {
    const meddling = reply(GOOD_NODES, [
      ...GOOD_EDGES,
      { from: "contact", to: "n1", answer: "high" },
      { from: "contact", to: "n1", answer: null },
    ]);
    const { callModel } = stub(meddling);
    const out = await run({ callModel });

    expect(out.source).toBe("model");
    const template = templateForGoal("invisalign").build();
    const contactId = template.nodes.find((n) => n.kind === "contact")!.id;
    expect(out.graph.edges.filter((e) => e.from === contactId)).toEqual(
      template.edges.filter((e) => e.from === contactId),
    );
  });

  it("restores tampered result copy and band routes after validation", () => {
    const template = templateForGoal("invisalign").build();
    const contactId = template.nodes.find((n) => n.kind === "contact")!.id;
    const tampered: FlowGraph = {
      ...template,
      nodes: template.nodes.map((n) =>
        n.kind === "outcome" ? { ...n, headline: "The best prices in town, guaranteed" } : n,
      ),
      edges: template.edges.filter((e) => e.from !== contactId),
    };

    const pinned = pinScaffoldNodes(tampered, "invisalign");
    expect(pinned.nodes).toEqual(template.nodes);
    expect(pinned.edges.filter((e) => e.from === contactId)).toEqual(
      template.edges.filter((e) => e.from === contactId),
    );
    expect(validateFlow(pinned).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE OPT-IN MERGE, and why the default above stays the default.
//
// The pin's original docstring called itself a no-op that "swaps nodes for
// identical ones". It was never that: it is a WHOLESALE OVERWRITE BY ID, and it
// only looked like a no-op because parseFlowReply cannot emit a welcome or an
// outcome node, so there has never been anything on one to overwrite.
//
// The AI-writer lane changes exactly that. The moment a model is asked to write
// the welcome headline or a result screen's blocks, the default pin deletes every
// word of it - silently, and with the scan running AFTERWARDS, so the restored
// template copy is what gets scanned, the graph comes back clean, and the owner is
// told "AI wrote your funnel" over the template's own headlines. Nothing errors.
// No test fails. That is why the opt-in is built and pinned HERE, ahead of the
// writer, rather than discovered later.
// ---------------------------------------------------------------------------

describe("pinScaffoldNodes — keepAuthoredCopy", () => {
  const STRIP: FlowBlock = {
    kind: "trust-strip",
    practiceName: "Vitality Dental",
    chips: ["Open Saturdays", "Free parking"],
  };

  /** The template, with copy an AI writer would have put on the pinned screens. */
  function authoredCopy(): FlowGraph {
    const template = templateForGoal("invisalign").build();
    return withRequiredSchemaVersion({
      ...template,
      nodes: template.nodes.map((n) => {
        if (n.kind === "welcome") {
          return {
            ...n,
            headline: "A few quick questions about your smile",
            intro: "It takes about a minute, and the team reads every answer.",
            blocks: [STRIP],
          };
        }
        // The band is DELIBERATELY wrong for this node's id: the scaffold has to
        // win on identity even while the copy is the model's.
        if (n.kind === "outcome" && n.id === "result-high") {
          return { ...n, band: "low" as const, headline: "You look ready to get started.", blocks: [STRIP] };
        }
        return n;
      }),
    });
  }

  it("keeps the authored headline, intro and blocks on the welcome screen", () => {
    const pinned = pinScaffoldNodes(authoredCopy(), "invisalign", { keepAuthoredCopy: true });
    const welcome = pinned.nodes.find((n) => n.kind === "welcome")!;

    expect(welcome.kind === "welcome" && welcome.headline).toBe("A few quick questions about your smile");
    expect(welcome.kind === "welcome" && welcome.intro).toBe(
      "It takes about a minute, and the team reads every answer.",
    );
    expect(welcome.kind === "welcome" && welcome.blocks).toEqual([STRIP]);
    // Cloned, not shared: the pin hands back furniture the caller can edit without
    // reaching into the graph it was given.
    expect(welcome.kind === "welcome" && welcome.blocks?.[0]).not.toBe(STRIP);
  });

  it("keeps the authored result copy but FORCES the band and the id from the template", () => {
    const pinned = pinScaffoldNodes(authoredCopy(), "invisalign", { keepAuthoredCopy: true });
    const high = pinned.nodes.find((n) => n.id === "result-high")!;

    expect(high.kind === "outcome" && high.headline).toBe("You look ready to get started.");
    expect(high.kind === "outcome" && high.blocks).toEqual([STRIP]);
    // The band is scoring, not copy. It is decided server-side after the
    // submission and the model gets no vote on it, opt-in or not.
    expect(high.kind === "outcome" && high.band).toBe("high");
    expect(validateFlow(pinned).ok).toBe(true);
  });

  it("changes neither the set of screens nor their order", () => {
    const authored = authoredCopy();
    const pinned = pinScaffoldNodes(authored, "invisalign", { keepAuthoredCopy: true });
    expect(pinned.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual(
      authored.nodes.map((n) => `${n.id}:${n.kind}`),
    );
  });

  it("still replaces the contact step wholesale: it carries no authored copy to keep", () => {
    const template = templateForGoal("invisalign").build();
    const contact = template.nodes.find((n) => n.kind === "contact")!;
    const tampered: FlowGraph = {
      ...template,
      nodes: template.nodes.map((n) =>
        n.kind === "contact" ? ({ ...n, headline: "Give us your number" } as FlowNode) : n,
      ),
    };

    const pinned = pinScaffoldNodes(tampered, "invisalign", { keepAuthoredCopy: true });
    expect(pinned.nodes.find((n) => n.kind === "contact")).toEqual(contact);
  });

  it("still restores the band routes wholesale", () => {
    const template = templateForGoal("invisalign").build();
    const contactId = template.nodes.find((n) => n.kind === "contact")!.id;
    const meddled: FlowGraph = {
      ...authoredCopy(),
      edges: [
        ...template.edges.filter((e) => e.from !== contactId),
        { from: contactId, to: "result-low", answer: "high" },
      ],
    };

    const pinned = pinScaffoldNodes(meddled, "invisalign", { keepAuthoredCopy: true });
    expect(pinned.edges.filter((e) => e.from === contactId)).toEqual(
      template.edges.filter((e) => e.from === contactId),
    );
  });

  it("leaves the default path byte-identical, whether the option is absent or off", () => {
    // The test above this describe ("restores tampered result copy...") is the
    // STATEMENT of the default. This pins that adding an option did not quietly
    // move it: an absent option, an empty object and an explicit false all restore.
    const authored = authoredCopy();
    const restored = JSON.stringify(pinScaffoldNodes(authored, "invisalign"));
    expect(JSON.stringify(pinScaffoldNodes(authored, "invisalign", {}))).toBe(restored);
    expect(JSON.stringify(pinScaffoldNodes(authored, "invisalign", { keepAuthoredCopy: false }))).toBe(
      restored,
    );
    const welcome = pinScaffoldNodes(authored, "invisalign").nodes.find((n) => n.kind === "welcome")!;
    expect(welcome.kind === "welcome" && "headline" in welcome).toBe(false);
  });

  // THE ORDERING THE MERGE TURNS INTO A CORRECTNESS DEPENDENCY.
  //
  // While the pin only ever RESTORED template copy, scanning before or after it
  // made no difference to what shipped. Once it can KEEP the model's words, a scan
  // that ran first would inspect copy that the pin then replaced, and the copy that
  // actually ships would never be scanned at all. Both halves are pinned: that
  // merged copy is visible to the scanner, and that vet() reads it in that order.
  it("leaves merged copy where the scanner can find it", () => {
    const template = templateForGoal("invisalign").build();
    const dirty: FlowGraph = {
      ...template,
      nodes: template.nodes.map((n) =>
        n.kind === "welcome" ? { ...n, headline: "The best implant prices in London" } : n,
      ),
    };

    const merged = pinScaffoldNodes(dirty, "invisalign", { keepAuthoredCopy: true });
    expect(scanFlowCopy(merged).some((h) => h.where === 'node "welcome".headline')).toBe(true);
    // And on the default path the same line is gone before the scanner sees it -
    // which is exactly why "scan after pin" stops being a formality.
    expect(scanFlowCopy(pinScaffoldNodes(dirty, "invisalign"))).toEqual([]);
  });

  it("scans AFTER pinning inside vet(), never before", () => {
    // MUTATION: swap the two lines in vet() and every merged line ships unscanned.
    // Read off the source because the ORDER is the property, and nothing about the
    // return value of a clean pass can distinguish the two orderings.
    const body = generateSource.slice(generateSource.indexOf("function vet("));
    const pin = body.indexOf("pinScaffoldNodes(");
    const scan = body.indexOf("scanFlowCopy(");
    expect(pin).toBeGreaterThan(-1);
    expect(scan).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(scan);
  });
});

// ---------------------------------------------------------------------------
// THE `screens` KEY: the words on the screens the model may not BUILD.
//
// The whole point of the second reply key is that the model never emits a welcome
// or an outcome node - it addresses one that already exists, by id, and the merge
// is a lookup. So every test below asks one of two questions: did the words the
// model wrote actually survive to the funnel the owner is shown, and did anything
// it is not allowed to write get in with them.
// ---------------------------------------------------------------------------

const PRACTICE = "Vitality Dental";

/** A reply carrying both keys. `screens` is keyed by SCAFFOLD id, never a new one. */
function replyWithScreens(screens: Record<string, unknown>, nodes = GOOD_NODES, edges = GOOD_EDGES): string {
  return JSON.stringify({ entry: nodes[0]!.id, nodes, edges, screens });
}

function welcomeOf(graph: FlowGraph) {
  const n = graph.nodes.find((x) => x.kind === "welcome");
  return n && n.kind === "welcome" ? n : null;
}

function resultOf(graph: FlowGraph, id: string) {
  const n = graph.nodes.find((x) => x.id === id);
  return n && n.kind === "outcome" ? n : null;
}

function write(reply: string | FlowModelReply, second?: string | FlowModelReply) {
  const { callModel, calls } = second === undefined ? stub(reply) : stub(reply, second);
  return {
    calls,
    callModel,
    run: () =>
      generateFlow({ goal: "invisalign", practiceName: PRACTICE, idealCustomer: "adults", callModel }),
  };
}

describe("generateFlow — the model writes the screens it may not build", () => {
  // THE ROUND TRIP THIS WHOLE LANE EXISTS FOR.
  //
  // MUTATION: drop `{ keepAuthoredCopy: true }` from the pin inside vet(). Every
  // assertion below fails - and in production nothing would: the funnel would come
  // back valid, clean, `source: "model"`, wearing the TEMPLATE's headlines, and the
  // owner would be told the AI wrote it. That silent-wipe is the failure this test
  // is here to make loud.
  it("carries the authored screen copy all the way to the returned funnel", async () => {
    const out = await write(
      replyWithScreens({
        welcome: {
          headline: "A few quick questions about your smile",
          intro: "It takes about a minute, and the team reads every answer.",
          blocks: [{ kind: "trust-strip", chips: ["Open Saturdays", "Free parking"] }],
        },
        "result-high": {
          headline: "You sound ready to take the next step",
          blocks: [
            {
              kind: "faq",
              items: [
                { q: "What happens now?", a: "The team will call you to arrange a first visit." },
                { q: "How long does it take?", a: "Your first visit is usually about half an hour." },
              ],
            },
          ],
        },
      }),
    ).run();

    expect(out.source).toBe("model");
    expect(validateFlow(out.graph).ok).toBe(true);
    expect(scanFlowCopy(out.graph)).toEqual([]);

    const welcome = welcomeOf(out.graph)!;
    expect(welcome.headline).toBe("A few quick questions about your smile");
    expect(welcome.intro).toBe("It takes about a minute, and the team reads every answer.");
    expect(welcome.blocks).toEqual([
      { kind: "trust-strip", practiceName: PRACTICE, chips: ["Open Saturdays", "Free parking"] },
    ]);

    const high = resultOf(out.graph, "result-high")!;
    expect(high.headline).toBe("You sound ready to take the next step");
    expect(high.blocks?.[0]?.kind).toBe("faq");
    // And the thing the copy may never move: the band is still the template's.
    expect(high.band).toBe("high");
  });

  // MUTATION: let `screens` be keyed by anything and the model can name a node it
  // invented. It cannot: the merge is a LOOKUP against the scaffold, so a key that
  // matches no screen is copy addressed to nobody, and no node appears.
  it("cannot add a screen by naming one that does not exist", async () => {
    const before = templateForGoal("invisalign").build();
    const out = await write(
      replyWithScreens({
        "result-enormous": { headline: "Book now and save" },
        contact: { headline: "Give us your number" },
      }),
    ).run();

    expect(out.source).toBe("model");
    expect(out.graph.nodes.some((n) => n.id === "result-enormous")).toBe(false);
    // The contact step is untouched: it has no headline to write, so a `screens`
    // entry naming it changes nothing at all.
    expect(out.graph.nodes.find((n) => n.kind === "contact")).toEqual(
      before.nodes.find((n) => n.kind === "contact"),
    );
    expect(out.graph.nodes.filter((n) => n.kind === "outcome").map((n) => n.id)).toEqual(
      before.nodes.filter((n) => n.kind === "outcome").map((n) => n.id),
    );
  });

  // THE CHARTER CLAUSE, ENFORCED IN CODE RATHER THAN IN A PROMPT.
  //
  // MUTATION: add "testimonial" (or "booking") back to WRITABLE_BLOCK_KINDS. A
  // fabricated patient quote lands on a live dental page and every other gate is
  // bypassed - blockToAdd never runs on this path, because the merge writes blocks
  // straight onto the graph.
  it("drops a testimonial and a booking block the model returned, and keeps the rest", async () => {
    const out = await write(
      replyWithScreens({
        "result-high": {
          headline: "You sound ready to take the next step",
          blocks: [
            { kind: "testimonial", quote: "Best decision I ever made.", attribution: "Sarah, Enfield" },
            { kind: "booking", headline: "Book your visit", blurb: "Pick a time that suits you." },
            { kind: "trust-strip", chips: ["A friendly team"] },
          ],
        },
      }),
    ).run();

    const high = resultOf(out.graph, "result-high")!;
    expect(high.blocks?.map((b) => b.kind)).toEqual(["trust-strip"]);
    expect(JSON.stringify(out.graph)).not.toContain("Sarah, Enfield");
    expect(JSON.stringify(out.graph)).not.toContain("Book your visit");
    // Dropped, never rejected: the funnel it came with is untouched.
    expect(out.source).toBe("model");
    expect(validateFlow(out.graph).ok).toBe(true);
  });

  // MUTATION: skip the manifest lookup and trust the model's string. Rule 13 would
  // then fail the whole funnel at save time over one picture - or worse, a
  // URL-shaped value would sit in the jsonb waiting for a renderer to trust it.
  it("drops an image block whose key is not in the library, never the funnel", async () => {
    const out = await write(
      replyWithScreens({
        welcome: {
          headline: "Tell us about your smile",
          blocks: [
            { kind: "image", image: "https://example.com/hero.jpg", alt: "A smile" },
            { kind: "image", image: "screens/does-not-exist", alt: "A smile" },
            { kind: "image", image: "conditions/crowded", alt: "Crowded teeth" },
            { kind: "image", image: "screens/aligners", alt: "A clear aligner tray" },
          ],
        },
      }),
    ).run();

    const welcome = welcomeOf(out.graph)!;
    // Only the one real HERO key survives: "conditions/crowded" is a real key but
    // an ANSWER tile, and rule 13's second half is about fitness for the slot.
    expect(welcome.blocks).toEqual([
      { kind: "image", image: "screens/aligners", alt: "A clear aligner tray" },
    ]);
    expect(welcome.headline).toBe("Tell us about your smile");
    expect(validateFlow(out.graph).ok).toBe(true);
  });

  // MUTATION: take the practice's name from the reply. The model then names the
  // practice on a trust strip, which is the same class of invention as a quote.
  it("heads a trust strip with the PRACTICE's name, never the model's", async () => {
    const out = await write(
      replyWithScreens({
        welcome: {
          blocks: [{ kind: "trust-strip", practiceName: "Smile Emporium", chips: ["Gentle care"] }],
        },
      }),
    ).run();

    expect(welcomeOf(out.graph)!.blocks).toEqual([
      { kind: "trust-strip", practiceName: PRACTICE, chips: ["Gentle care"] },
    ]);
    expect(JSON.stringify(out.graph)).not.toContain("Smile Emporium");
  });

  it("writes no trust strip at all when there is no practice name to head it with", async () => {
    const { callModel } = stub(
      replyWithScreens({ welcome: { blocks: [{ kind: "trust-strip", chips: ["Gentle care"] }] } }),
    );
    const out = await generateFlow({ goal: "invisalign", callModel });
    expect(welcomeOf(out.graph)!.blocks).toBeUndefined();
    expect(out.source).toBe("model");
  });

  // Rule 12's minimums, applied at the PARSE so a block that could not validate
  // never becomes a validation failure the model has to spend a repair call on.
  it("drops a one-question faq and a chipless trust strip before they can fail validation", async () => {
    const out = await write(
      replyWithScreens({
        welcome: {
          blocks: [
            { kind: "faq", items: [{ q: "What happens now?", a: "The team will call you." }] },
            { kind: "trust-strip", chips: [] },
          ],
        },
        "result-low": { headline: "Have a read, and come back when you are ready" },
      }),
    ).run();

    expect(welcomeOf(out.graph)!.blocks).toBeUndefined();
    expect(resultOf(out.graph, "result-low")!.headline).toBe(
      "Have a read, and come back when you are ready",
    );
    expect(out.source).toBe("model");
    expect(callsOnce(out)).toBe(true);
  });

  // THE TWO LOCKS, TESTED SEPARATELY, because the behavioural test above cannot
  // tell them apart: adding "testimonial" to the allowlist changes nothing on its
  // own (no branch builds one), and adding a branch changes nothing on its own
  // (the allowlist stops it). Each is only a lock while the other is also there,
  // so each gets its own assertion.
  //
  // MUTATION (lock 1): move "testimonial" into WRITABLE_BLOCK_KINDS - this fails.
  // MUTATION (lock 2): add a `kind === "testimonial"` branch to parseScreenBlock
  // that returns one - the source assertion fails.
  it("classifies EVERY block kind as writable or not, with the two named refusals", () => {
    expect(WRITABLE_BLOCK_KINDS).toEqual(["trust-strip", "faq", "image"]);
    expect(UNWRITABLE_BLOCK_KINDS).toEqual(["testimonial", "booking"]);
    // Exhaustive and disjoint: a NEW block kind in flow.ts fails here until
    // somebody decides whether a model may assert it.
    expect([...WRITABLE_BLOCK_KINDS, ...UNWRITABLE_BLOCK_KINDS].sort()).toEqual(
      [...FLOW_BLOCK_KINDS].sort(),
    );
    for (const kind of UNWRITABLE_BLOCK_KINDS) {
      expect(WRITABLE_BLOCK_KINDS).not.toContain(kind);
    }
  });

  it("holds no code that can build a testimonial or a booking block", () => {
    // Read off the source, because the property is an ABSENCE and no return value
    // of a working parser can demonstrate one. The refusal doctrine is written out
    // at flow-inspect.ts blockToAdd and flow-assist.ts; this is the third door,
    // and the only one on the writer's own merge path.
    for (const kind of UNWRITABLE_BLOCK_KINDS) {
      expect(generateSource, `flow-generate.ts constructs a ${kind} block`).not.toContain(
        `kind: "${kind}"`,
      );
    }
  });

  it("offers the writable kinds and forbids the other two, by name, in the prompt", () => {
    const { system, user } = buildFlowPrompt({ goal: "invisalign", practiceName: PRACTICE });
    expect(system).toContain('"screens"');
    expect(system).toContain('"kind":"trust-strip"');
    expect(system).toContain('"kind":"faq"');
    expect(system).toContain('"kind":"image"');
    // Named ALOUD as forbidden, not merely left off the list: a model writing a
    // page that obviously wants a testimonial reaches for one unless told.
    expect(system).toMatch(/NEVER write a testimonial/);
    expect(system).toContain("booking block");
    // The ids the merge looks up have to BE in the prompt, or the model guesses.
    expect(user).toContain("result-high");
    expect(user).toContain("result-medium");
    expect(user).toContain("result-low");
    expect(user).toContain(PRACTICE);
    // Only keys the manifest can resolve are offered.
    expect(system).toContain("screens/aligners");
    expect(system).not.toContain("http");
  });
});

/** A single-call pass: the shorthand every "no repair was needed" assertion wants. */
function callsOnce(out: Awaited<ReturnType<typeof generateFlow>>): boolean {
  return out.reason === null && out.source === "model";
}

describe("generateFlow — compliance: regenerate once, then strip", () => {
  it("regenerates once when a transition carries funding jargon", async () => {
    const { callModel, calls } = stub(JARGON, GOOD);
    const out = await run({ callModel });

    expect(out.source).toBe("model-repair");
    expect(callModel).toHaveBeenCalledTimes(2);
    // Quoted back in the write gate's own words (describeFlowCopyHits), so the
    // model is repairing against the exact rule the save will re-apply.
    expect(calls[1]!.user).toContain("[jargon]");
    expect(calls[1]!.user).toContain('node "n4".transition');
    expect(transitionsOf(out.graph).join(" ")).not.toMatch(/\bNHS\b/i);
  });

  it("strips the offending line when the second reply is still non-compliant", async () => {
    const { callModel } = stub(JARGON, JARGON);
    const out = await run({ callModel });

    expect(out.source).toBe("model-stripped");
    expect(validateFlow(out.graph).ok).toBe(true);
    expect(scanFlowCopy(out.graph)).toEqual([]);
    // The funnel survives: only the one bad line is gone.
    expect(transitionsOf(out.graph)).toContain("Lovely. When would you like to start?");
    expect(out.graph.nodes.filter((n) => n.kind === "question")).toHaveLength(6);
  });

  it("scans every kind of authored line, not just question transitions", () => {
    const template = templateForGoal("general").build();
    const dirty: FlowGraph = {
      ...template,
      nodes: template.nodes.map((n) =>
        n.kind === "outcome" && n.band === "high" ? { ...n, headline: "Private patients only" } : n,
      ),
      edges: template.edges.map((e, i) => (i === 0 ? { ...e, transition: "We are the best in the UK" } : e)),
    };
    const hits = scanFlowCopy(dirty);
    expect(hits.some((h) => h.where.includes("result-high"))).toBe(true);
    expect(hits.some((h) => h.matched.toLowerCase() === "best")).toBe(true);
    expect(scanFlowCopy(stripFlowCopy(dirty))).toEqual([]);
  });

  // A2 blocks. stripFlowCopy promises that what comes out passes the write gate,
  // so a block whose wording failed has to go the same way an unclean transition
  // does - and a block that is fine has to survive a rebuild caused by a sibling
  // field, or the strip silently deletes an owner's furniture.
  it("drops a whole block whose wording failed, and keeps the ones that passed", () => {
    const clean: FlowBlock = {
      kind: "trust-strip",
      practiceName: "Vitality Dental",
      chips: ["Open Saturdays"],
    };
    const dirtyBlock: FlowBlock = {
      kind: "testimonial",
      quote: "Honestly the best in London",
      attribution: "R",
    };
    const template = templateForGoal("general").build();
    const dirty: FlowGraph = {
      ...template,
      nodes: template.nodes.map((n) =>
        n.kind === "welcome" ? { ...n, headline: "We are the finest", blocks: [clean, dirtyBlock] } : n,
      ),
    };

    const out = stripFlowCopy(dirty);
    const welcome = out.nodes.find((n) => n.kind === "welcome")!;
    expect(welcome.kind === "welcome" && welcome.blocks).toEqual([clean]);
    expect(welcome.kind === "welcome" && "headline" in welcome).toBe(false);
    expect(scanFlowCopy(out)).toEqual([]);
    expect(validateFlow(out).ok).toBe(true);
  });

  it("keeps a clean block when the sibling headline is the thing being stripped", () => {
    const clean: FlowBlock = {
      kind: "testimonial",
      quote: "The team explained every step and I never felt rushed.",
      attribution: "Hannah, Enfield",
    };
    const template = templateForGoal("general").build();
    const dirty: FlowGraph = {
      ...template,
      nodes: template.nodes.map((n) =>
        n.kind === "outcome" && n.band === "high"
          ? { ...n, headline: "Private patients only", blocks: [clean] }
          : n,
      ),
    };
    const result = stripFlowCopy(dirty).nodes.find((n) => n.kind === "outcome" && n.band === "high")!;
    expect(result.kind === "outcome" && result.blocks).toEqual([clean]);
    expect(result.kind === "outcome" && "headline" in result).toBe(false);
  });

  // ANSWER-CARD PICTURES SURVIVE THE STRIP.
  //
  // A question node whose lead-in did not pass is REBUILT from three fields - id,
  // kind, questionId - so every other field it carried has to be carried across by
  // hand. `optionImages` is the only one in that position today, and the carry is a
  // single line of stripFlowCopy.
  //
  // MUTATION: delete that line. The funnel still validates (rule 14 has no
  // minimum), the scan still passes, nothing errors, and every answer picture an
  // owner chose is gone from any funnel that ever needed stripping. The block
  // equivalents are pinned two tests up; this was the asymmetric gap.
  //
  // BOTH BRANCHES OF THE SAME `if`, because isCleanLine(undefined) is FALSE: a
  // question with no lead-in at all takes the rebuild path exactly as a
  // jargon-carrying one does, which makes it the COMMON case, not the rare one.
  // The sibling doctrine is written out at flow-edit.ts's setQuestionTransition
  // and pinned by "keeps the answer pictures on a question whose lead-in is
  // edited"; this is the same pin on the generator's own rebuild.
  it("carries the answer pictures through a strip when the lead-in is the dirty line", () => {
    const dirty = picturedTimeline("Next, whether you are NHS or private with us.");
    const out = stripFlowCopy(dirty);
    const node = out.nodes.find((n) => n.id === `q-${Q_TIMELINE}`)!;

    expect(node.kind === "question" && "transition" in node).toBe(false);
    expect(node.kind === "question" && node.optionImages).toEqual(TIMELINE_PICTURES);
    // A fresh array, not the caller's: the rebuild branch clones, the way
    // cleanBlocks does, so a later editor cannot reach back into the input graph.
    expect(node.kind === "question" && node.optionImages).not.toBe(TIMELINE_PICTURES);
    expect(scanFlowCopy(out)).toEqual([]);
    expect(validateFlow(out).ok).toBe(true);
  });

  it("carries them when the question had no lead-in at all, which is the common case", () => {
    const bare = picturedTimeline(undefined);
    const dirtyElsewhere: FlowGraph = {
      ...bare,
      nodes: bare.nodes.map((n) =>
        n.kind === "outcome" && n.band === "high" ? { ...n, headline: "Private patients only" } : n,
      ),
    };

    const out = stripFlowCopy(dirtyElsewhere);
    const node = out.nodes.find((n) => n.id === `q-${Q_TIMELINE}`)!;
    expect(node.kind === "question" && node.optionImages).toEqual(TIMELINE_PICTURES);
    expect(scanFlowCopy(out)).toEqual([]);
    expect(validateFlow(out).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POISONED SCREEN COPY. The screens key opened a new road for non-compliant
// wording, and it has to end where every other one does: regenerate once, then
// strip, and NEVER a silent swap to the template. A funnel the owner is told was
// written for them, which is actually the starter with the starter's headlines,
// is the failure this whole lane was built to avoid.
// ---------------------------------------------------------------------------

describe("generateFlow — poisoned screen copy never becomes a silent template swap", () => {
  const POISON = replyWithScreens({
    welcome: {
      headline: "The best implant prices in London",
      intro: "It takes about a minute, and the team reads every answer.",
    },
    "result-high": { headline: "You sound ready to take the next step" },
  });
  const CLEAN = replyWithScreens({
    welcome: {
      headline: "A few quick questions about your smile",
      intro: "It takes about a minute, and the team reads every answer.",
    },
    "result-high": { headline: "You sound ready to take the next step" },
  });

  it("regenerates ONCE, quoting the offending headline in the write gate's own words", async () => {
    const { callModel, calls, run: go } = write(POISON, CLEAN);
    const out = await go();

    expect(out.source).toBe("model-repair");
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(calls[1]!.user).toContain('node "welcome".headline');
    expect(calls[1]!.user).toContain("best");
    expect(welcomeOf(out.graph)!.headline).toBe("A few quick questions about your smile");
    expect(scanFlowCopy(out.graph)).toEqual([]);
  });

  it("strips the one bad line and keeps every other written word", async () => {
    const out = await write(POISON, POISON).run();

    expect(out.source).toBe("model-stripped");
    expect(out.source).not.toBe("template");
    const welcome = welcomeOf(out.graph)!;
    expect("headline" in welcome).toBe(false);
    // The clean lines the model wrote are still here: the strip costs one line,
    // not the rewrite and not the funnel.
    expect(welcome.intro).toBe("It takes about a minute, and the team reads every answer.");
    expect(resultOf(out.graph, "result-high")!.headline).toBe("You sound ready to take the next step");
    expect(scanFlowCopy(out.graph)).toEqual([]);
    expect(validateFlow(out.graph).ok).toBe(true);
  });

  // MUTATION: scan before the pin inside vet(). This is the test that catches it
  // END TO END - the ordering test above reads the source, and this one proves
  // what the source order is FOR. Scanning first inspects the template's own
  // headline, finds it clean, and ships "The best implant prices in London".
  it("scans the words the model wrote, not the template's they replaced", async () => {
    const out = await write(POISON).run();
    expect(out.source).not.toBe("model");
    expect(JSON.stringify(out.graph)).not.toContain("best implant prices");
  });
});

// ---------------------------------------------------------------------------
// REWRITE. Same funnel, different words - and the floor is the OWNER'S GRAPH.
// ---------------------------------------------------------------------------

describe("generateFlow — rewrite: the words change and nothing else does", () => {
  // THE FIXTURE IS THE OWNER'S FUNNEL, NOT THE GOAL'S STARTER, and the difference
  // is load-bearing rather than decorative. A template is only the shape a funnel
  // BEGAN as; what makes it theirs is the wording they typed over it. Were BASE
  // the template verbatim, "hands back the owner's own funnel" would be equally
  // true of handing back templateForGoal("invisalign").build() - the floor tests
  // below would pass against the very swap they exist to catch. So the welcome
  // screen and all three results carry lines no template in this repo contains.
  const OWNER_WELCOME = {
    headline: "Your smile, in about a minute",
    intro: "Answer a few quick questions and someone from the team will be in touch about what happens next.",
  } as const;
  const OWNER_HEADLINES: Record<string, string> = {
    high: "Wonderful. Let us find you a time that suits.",
    medium: "Thank you. Someone from the team will be in touch.",
    low: "Thank you for telling us where you have got to.",
  };
  const STARTER = templateForGoal("invisalign").build();
  const BASE: FlowGraph = {
    ...STARTER,
    nodes: STARTER.nodes.map((n): FlowNode => {
      if (n.kind === "welcome") return { ...n, ...OWNER_WELCOME };
      if (n.kind === "outcome") return { ...n, headline: OWNER_HEADLINES[n.band]! };
      return n;
    }),
  };

  /** The reply a well-behaved rewriter sends: the funnel echoed back, reworded. */
  function echo(
    graph: FlowGraph,
    copy: {
      nodes?: Record<string, string>;
      edges?: Record<string, string>;
      screens?: Record<string, unknown>;
    },
  ): string {
    return JSON.stringify({
      nodes: graph.nodes
        .filter((n) => n.kind === "question")
        .map((n) => ({
          id: n.id,
          questionId: n.kind === "question" ? n.questionId : "",
          transition: copy.nodes?.[n.id],
        })),
      edges: graph.edges.map((e) => ({
        from: e.from,
        to: e.to,
        answer: e.answer,
        transition: copy.edges?.[`${e.from}>${e.to}`],
      })),
      screens: copy.screens ?? {},
    });
  }

  function rewrite(...replies: (string | FlowModelReply)[]) {
    const { callModel, calls } = stub(...replies);
    return {
      calls,
      callModel,
      run: () =>
        generateFlow({ goal: "invisalign", mode: "rewrite", graph: BASE, practiceName: PRACTICE, callModel }),
    };
  }

  const TIMELINE = `q-${Q_TIMELINE}`;

  // THE FIXTURE'S OWN PREMISE, pinned so it cannot rot back. Every floor test in
  // this describe is only as strong as "BASE is not the template": let that stop
  // being true and they all keep passing while proving nothing.
  it("is a funnel the goal's template could not be mistaken for", () => {
    expect(BASE).not.toEqual(templateForGoal("invisalign").build());
    expect(sameFlowStructure(templateForGoal("invisalign").build(), BASE)).toBe(true);
    // ...and it is a funnel the product would actually accept, so nothing below
    // passes only because the fixture was never shippable in the first place.
    expect(validateFlow(BASE).ok).toBe(true);
    expect(scanFlowCopy(BASE)).toEqual([]);
  });

  it("changes the wording and leaves the structure byte for byte", async () => {
    const out = await rewrite(
      echo(BASE, {
        nodes: { [TIMELINE]: "Lovely. When would you like to start?" },
        screens: { welcome: { headline: "A minute of your time, and the team takes it from there" } },
      }),
    ).run();

    expect(out.source).toBe("model");
    expect(sameFlowStructure(BASE, out.graph)).toBe(true);
    const timeline = out.graph.nodes.find((n) => n.id === TIMELINE)!;
    expect(timeline.kind === "question" && timeline.transition).toBe(
      "Lovely. When would you like to start?",
    );
    expect(welcomeOf(out.graph)!.headline).toBe(
      "A minute of your time, and the team takes it from there",
    );
    expect(validateFlow(out.graph).ok).toBe(true);
  });

  // MUTATION: read structure out of the reply (assemble it like a draft). Every
  // one of these becomes a change to a funnel somebody built by hand.
  it("ignores every structural instruction a rewrite reply can carry", async () => {
    const meddling = JSON.stringify({
      entry: "q-treatment_interest",
      nodes: [
        // A node that is not in the funnel, a questionId swapped under an id that
        // is, and the funnel's real nodes left out entirely.
        { id: "brand-new", questionId: "readiness", transition: "Hello there" },
        { id: TIMELINE, questionId: "budget_readiness", transition: "When would suit you?" },
      ],
      edges: [
        { from: "brand-new", to: "contact", answer: null },
        { from: "contact", to: "result-low", answer: "high" },
      ],
      screens: { "result-high": { headline: "You sound ready to take the next step" } },
    });
    const out = await rewrite(meddling).run();

    expect(out.source).toBe("model");
    expect(sameFlowStructure(BASE, out.graph)).toBe(true);
    expect(out.graph.nodes.some((n) => n.id === "brand-new")).toBe(false);
    expect(out.graph.nodes.map((n) => n.id)).toEqual(BASE.nodes.map((n) => n.id));
    expect(out.graph.edges).toHaveLength(BASE.edges.length);
    // The questionId under that id is untouched, so the funnel still asks what it
    // asked - and the LINE the model wrote for it did land.
    const timeline = out.graph.nodes.find((n) => n.id === TIMELINE)!;
    expect(timeline.kind === "question" && timeline.questionId).toBe(Q_TIMELINE);
    expect(timeline.kind === "question" && timeline.transition).toBe("When would suit you?");
    expect(resultOf(out.graph, "result-high")!.headline).toBe("You sound ready to take the next step");
  });

  it("keeps the owner's own words wherever the model wrote nothing", async () => {
    const before = BASE.nodes.find((n) => n.id === TIMELINE)!;
    const out = await rewrite(echo(BASE, { screens: { welcome: { intro: "It only takes a minute." } } })).run();

    const after = out.graph.nodes.find((n) => n.id === TIMELINE)!;
    expect(after.kind === "question" && after.transition).toBe(
      before.kind === "question" ? before.transition : undefined,
    );
    // Every result headline the model ignored is still the one the owner had.
    for (const n of BASE.nodes.filter((x) => x.kind === "outcome")) {
      expect(resultOf(out.graph, n.id)!.headline).toBe(n.kind === "outcome" ? n.headline : undefined);
    }
  });

  it("leaves the content blocks the owner placed exactly where they were", async () => {
    const strip: FlowBlock = {
      kind: "trust-strip",
      practiceName: PRACTICE,
      chips: ["Open Saturdays", "Free parking"],
    };
    const withBlocks = withRequiredSchemaVersion({
      ...BASE,
      nodes: BASE.nodes.map((n) => (n.kind === "welcome" ? { ...n, blocks: [strip] } : n)),
    });
    const { callModel } = stub(
      echo(withBlocks, {
        screens: {
          welcome: {
            headline: "A few quick questions",
            blocks: [{ kind: "trust-strip", chips: ["Something else entirely"] }],
          },
        },
      }),
    );
    const out = await generateFlow({
      goal: "invisalign",
      mode: "rewrite",
      graph: withBlocks,
      practiceName: PRACTICE,
      callModel,
    });

    expect(welcomeOf(out.graph)!.headline).toBe("A few quick questions");
    // The chips are furniture the owner placed. A rewrite writes lines, not
    // sections, and the per-line assist is the control for a chip.
    expect(welcomeOf(out.graph)!.blocks).toEqual([strip]);
    expect(sameFlowStructure(withBlocks, out.graph)).toBe(true);
  });

  // THE FLOOR, AND THE ONE THAT MATTERS MOST.
  //
  // MUTATION: let the rewrite path fall through to templateResult. Every case
  // below silently replaces a funnel somebody built with the goal's starter, and
  // the owner is told "the writer could not settle on a funnel" about a funnel
  // they never asked to be written.
  it.each([
    ["prose with no JSON in it", "I am sorry, I cannot rewrite funnels." as string | FlowModelReply],
    ["a reply cut off at the cap", { text: "{}", stopReason: "max_tokens" }],
    ["JSON that is not a funnel", '{"words":"nicer"}'],
    ["an empty object", "{}"],
  ])("hands back the owner's own funnel, untouched, on %s", async (_name, bad) => {
    const out = await rewrite(bad, bad).run();

    expect(out.source).toBe("unchanged");
    expect(out.source).not.toBe("template");
    expect(out.graph).toEqual(BASE);
    // AND NOT THE STARTER FOR THIS GOAL, which is the swap the line above cannot
    // see on its own. BASE grew out of the invisalign template, so a floor that
    // reached for templateForGoal(goal) would hand back something of the same
    // shape, of the same goal, containing not one word the owner wrote.
    expect(out.graph).not.toEqual(templateForGoal("invisalign").build());
    expect(welcomeOf(out.graph)!.headline).toBe(OWNER_WELCOME.headline);
  });

  it("hands back the owner's own funnel when the model throws", async () => {
    const callModel = vi.fn(async () => {
      throw new Error("upstream 529");
    });
    const out = await generateFlow({ goal: "invisalign", mode: "rewrite", graph: BASE, callModel });
    expect(out.source).toBe("unchanged");
    expect(out.reason).toBe("model-error");
    expect(out.graph).toEqual(BASE);
    expect(out.graph).not.toEqual(templateForGoal("invisalign").build());
  });

  it("refuses to rewrite at all when no funnel was sent, rather than drafting a new one", async () => {
    const { callModel } = stub(GOOD);
    const out = await generateFlow({ goal: "invisalign", mode: "rewrite", callModel });
    expect(out.source).toBe("template");
    expect(callModel).not.toHaveBeenCalled();
  });

  it("regenerates once on jargon, then keeps the owner's line rather than deleting it", async () => {
    const dirty = echo(BASE, {
      nodes: { [TIMELINE]: "Next, whether you are NHS or private with us." },
      screens: { welcome: { headline: "A few quick questions about your smile" } },
    });
    const before = BASE.nodes.find((n) => n.id === TIMELINE)!;
    const out = await rewrite(dirty, dirty).run();

    expect(out.source).toBe("model-stripped");
    expect(scanFlowCopy(out.graph)).toEqual([]);
    expect(sameFlowStructure(BASE, out.graph)).toBe(true);
    // THE DIFFERENCE FROM A DRAFT. stripFlowCopy would leave this field EMPTY;
    // on a rewrite the offending line is dropped from the REPLY, so the owner's
    // own words are what remain.
    const after = out.graph.nodes.find((n) => n.id === TIMELINE)!;
    expect(after.kind === "question" && after.transition).toBe(
      before.kind === "question" ? before.transition : undefined,
    );
    // ...and the line the model got right still landed.
    expect(welcomeOf(out.graph)!.headline).toBe("A few quick questions about your smile");
  });

  // THE FUNNEL THAT ARRIVED ALREADY DIRTY. A draft is written from nothing, so
  // every line in it is the model's; a rewrite starts from words somebody else
  // typed, and those words may themselves be wording a patient must not see (a
  // draft saved before the scanner existed, a funnel imported from elsewhere).
  //
  // MUTATION: drop the scan from `settle`. The rewrite then reports success over a
  // funnel that still fails the compliance gate - and the owner discovers it when
  // the SAVE refuses, having been told the words were rewritten.
  describe("when the owner's own funnel already carries jargon", () => {
    const DIRTY: FlowGraph = {
      ...BASE,
      nodes: BASE.nodes.map((n) =>
        n.kind === "welcome" ? { ...n, headline: "NHS and private patients welcome" } : n,
      ),
    };

    function rewriteDirty(...replies: string[]) {
      const { callModel } = stub(...replies);
      return generateFlow({ goal: "invisalign", mode: "rewrite", graph: DIRTY, callModel });
    }

    it("refuses to call it rewritten while the offending line is still there", async () => {
      // The model rewrites something ELSE and leaves the owner's dirty headline.
      const untouched = echo(DIRTY, { nodes: { [TIMELINE]: "When would you like to start?" } });
      const out = await rewriteDirty(untouched, untouched);

      expect(out.source).toBe("unchanged");
      expect(out.graph).toEqual(DIRTY);
      // Nothing was lost and nothing was claimed: the owner still has their funnel,
      // and has not been told a scan passed that did not.
      expect(scanFlowCopy(out.graph).length).toBeGreaterThan(0);
    });

    it("takes the rewrite happily when the model FIXES the offending line", async () => {
      const fixed = echo(DIRTY, {
        screens: { welcome: { headline: "A few quick questions about your smile" } },
      });
      const out = await rewriteDirty(fixed);

      expect(out.source).toBe("model");
      expect(scanFlowCopy(out.graph)).toEqual([]);
      expect(welcomeOf(out.graph)!.headline).toBe("A few quick questions about your smile");
      expect(sameFlowStructure(DIRTY, out.graph)).toBe(true);
    });
  });

  it("carries the funnel and the SAME compliance clauses as a draft into the prompt", () => {
    const { system, user } = buildRewritePrompt(BASE, { goal: "invisalign", practiceName: PRACTICE });
    expect(user).toContain(TIMELINE);
    expect(user).toContain("result-high");
    expect(user).toContain("edge ");
    expect(user).toContain(PRACTICE);
    expect(system).toContain("WORDING ONLY");
    // One list of compliance clauses for both modes, or a rewrite quietly becomes
    // allowed to say something a draft is not.
    const draft = buildFlowPrompt({ goal: "invisalign", practiceName: PRACTICE }).system;
    for (const clause of [
      "Never mention NHS or private care",
      "never claim to be the best",
      "Never give clinical advice",
    ]) {
      expect(system, `rewrite prompt is missing: ${clause}`).toContain(clause);
      expect(draft, `draft prompt is missing: ${clause}`).toContain(clause);
    }
  });
});

describe("sameFlowStructure", () => {
  const BASE = templateForGoal("invisalign").build();

  it("is true when only the rewritable words differ", () => {
    const reworded: FlowGraph = {
      ...BASE,
      nodes: BASE.nodes.map((n) => {
        if (n.kind === "welcome") return { ...n, headline: "New words", intro: "More new words" };
        if (n.kind === "question") return { ...n, transition: "A different lead-in" };
        if (n.kind === "outcome") return { ...n, headline: "A different heading" };
        return n;
      }),
      edges: BASE.edges.map((e) => ({ ...e, transition: "A different line" })),
    };
    expect(sameFlowStructure(BASE, reworded)).toBe(true);
    // ...and it does not care what order the keys were written in.
    expect(sameFlowStructure(BASE, JSON.parse(JSON.stringify(BASE)) as FlowGraph)).toBe(true);
  });

  // MUTATION: any of these silently passing is a rewrite that redesigned a funnel.
  it.each<[string, (g: FlowGraph) => FlowGraph]>([
    ["a node removed", (g) => ({ ...g, nodes: g.nodes.slice(1) })],
    ["a node added", (g) => ({ ...g, nodes: [...g.nodes, { id: "extra", kind: "contact" }] })],
    ["an edge removed", (g) => ({ ...g, edges: g.edges.slice(1) })],
    [
      "an edge rerouted",
      (g) => ({ ...g, edges: g.edges.map((e, i) => (i === 0 ? { ...e, to: "contact" } : e)) }),
    ],
    [
      "a band changed",
      (g) => ({
        ...g,
        nodes: g.nodes.map((n) => (n.kind === "outcome" && n.band === "high" ? { ...n, band: "low" as const } : n)),
      }),
    ],
    [
      "a question swapped",
      (g) => ({
        ...g,
        nodes: g.nodes.map((n) => (n.kind === "question" ? { ...n, questionId: "readiness" } : n)),
      }),
    ],
    [
      "a content block added",
      (g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.kind === "welcome"
            ? { ...n, blocks: [{ kind: "trust-strip" as const, practiceName: "X", chips: ["Y"] }] }
            : n,
        ),
      }),
    ],
    ["the entry moved", (g) => ({ ...g, entry: "contact" })],
    ["the screens reordered", (g) => ({ ...g, nodes: [...g.nodes].reverse() })],
  ])("is false when %s", (_name, mutate) => {
    expect(sameFlowStructure(BASE, mutate(BASE))).toBe(false);
  });
});

describe("applyRewrittenCopy", () => {
  const BASE = templateForGoal("invisalign").build();

  it("never changes the structure, whatever the reply says", () => {
    const parsed = parseFlowReply(
      JSON.stringify({
        entry: "somewhere-else",
        nodes: [
          { id: "invented", questionId: "readiness", transition: "Hello" },
          { id: `q-${Q_TIMELINE}`, questionId: "location", transition: "When would suit?" },
        ],
        edges: [{ from: "invented", to: "invented", answer: null, transition: "Off we go" }],
        screens: { nowhere: { headline: "Nobody's screen" } },
      }),
    )!;
    const out = applyRewrittenCopy(BASE, parsed);
    expect(sameFlowStructure(BASE, out)).toBe(true);
    expect(out.entry).toBe(BASE.entry);
    expect(out.nodes).toHaveLength(BASE.nodes.length);
    expect(out.edges).toHaveLength(BASE.edges.length);
  });

  // MUTATION: key the edge map by joining the three parts with a separator - a
  // space, a pipe, anything. A node id is whatever the model sent, so the
  // separator can also be INSIDE one, and these two different branches collide:
  // one lead-in lands on both, silently and plausibly.
  it("cannot confuse two wires whose ids collide under a joined key", () => {
    const collide: FlowGraph = {
      schemaVersion: 2,
      entry: "welcome",
      nodes: [
        { id: "welcome", kind: "welcome" },
        { id: "a b", kind: "question", questionId: "treatment_interest" },
        { id: "a", kind: "question", questionId: "timeline" },
        { id: "c", kind: "question", questionId: "location" },
        { id: "b c", kind: "question", questionId: "readiness" },
      ],
      edges: [
        { from: "welcome", to: "a b", answer: null },
        { from: "a b", to: "c", answer: null },
        { from: "a", to: "b c", answer: null },
      ],
    };
    const parsed = parseFlowReply(
      JSON.stringify({
        nodes: [{ id: "x", questionId: "readiness" }],
        edges: [{ from: "a b", to: "c", answer: null, transition: "Only this one" }],
      }),
    )!;
    const out = applyRewrittenCopy(collide, parsed);

    expect(out.edges[1]!.transition).toBe("Only this one");
    expect(out.edges[2]!.transition).toBeUndefined();
    expect(out.edges.filter((e) => e.transition === "Only this one")).toHaveLength(1);
  });

  it("matches an edge lead-in on the wire itself, never on its position", () => {
    const edge = BASE.edges[2]!;
    const parsed = parseFlowReply(
      JSON.stringify({
        nodes: [{ id: "x", questionId: "readiness" }],
        // Same from/to/answer, sent LAST rather than third.
        edges: [{ from: edge.from, to: edge.to, answer: edge.answer, transition: "On we go" }],
      }),
    )!;
    const out = applyRewrittenCopy(BASE, parsed);
    expect(out.edges[2]!.transition).toBe("On we go");
    expect(out.edges.filter((e) => e.transition === "On we go")).toHaveLength(1);
  });
});

describe("generateFlow — house style on generated copy", () => {
  it("normalises dashes rather than spending a repair call on them", async () => {
    const dashed = reply(
      GOOD_NODES.map((n) => (n.id === "n3" ? { ...n, transition: "Great — and when suits you?" } : n)),
      GOOD_EDGES,
    );
    const { callModel } = stub(dashed);
    const out = await run({ callModel });

    expect(out.source).toBe("model");
    expect(transitionsOf(out.graph).join(" ")).not.toMatch(/[—–]/);
    expect(transitionsOf(out.graph)).toContain("Great, and when suits you?");
  });

  it("drops an over-long line instead of cutting a patient's sentence in half", async () => {
    const long = reply(
      GOOD_NODES.map((n) => (n.id === "n3" ? { ...n, transition: "word ".repeat(60) } : n)),
      GOOD_EDGES,
    );
    const { callModel } = stub(long);
    const out = await run({ callModel });

    expect(out.source).toBe("model");
    const n3 = out.graph.nodes.find((n) => n.id === "n3")!;
    expect(n3.kind === "question" && n3.transition).toBeFalsy();
  });
});

describe("buildFlowPrompt", () => {
  it("carries the campaign's own targeting into the user turn", () => {
    const { system, user } = buildFlowPrompt({
      goal: "implants",
      idealCustomer: "retired  patients\nwith missing teeth",
      targetBudget: "finance",
    });
    expect(user).toContain("Dental implants");
    expect(user).toContain("retired patients with missing teeth"); // whitespace collapsed
    expect(user).toContain("Open to finance");
    // The rules the validator will actually enforce have to be IN the prompt.
    expect(system).toContain("budget_readiness");
    expect(system).toContain("location");
    expect(system).toContain('"contact"');
  });

  it("says 'not specified' rather than an empty line when there is no ideal patient", () => {
    expect(buildFlowPrompt({ goal: "hygiene" }).user).toContain("not specified");
  });
});
