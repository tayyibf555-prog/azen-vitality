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

import { describe, it, expect, vi } from "vitest";
import { validateFlow } from "./flow-validate";
import { templateForGoal } from "./flow-templates";
import { scanFlowCopy } from "./flow-copy";
import type { FlowGraph } from "./flow";
import {
  buildFlowPrompt,
  generateFlow,
  parseFlowReply,
  pinScaffoldNodes,
  renderQuestionBank,
  stripFlowCopy,
  type FlowModelReply,
} from "./flow-generate";

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
