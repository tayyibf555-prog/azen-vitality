import { describe, it, expect } from "vitest";
import { FLOW_LIMITS, type FlowGraph } from "./flow";
import { validateFlow } from "./flow-validate";
import { FLOW_TEMPLATES, buildScratchFlow, templateForGoal } from "./flow-templates";
import { Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT } from "./quiz";
import {
  addEdge,
  defaultTargetOf,
  describeEdge,
  describeNode,
  routableAnswers,
  insertQuestionOnEdge,
  insertableQuestions,
  nextNodeId,
  removeEdge,
  removeNode,
  setEdgeAnswer,
  setEdgeTarget,
  setEdgeTransition,
  setOutcomeHeadline,
  setQuestionTransition,
  setWelcomeCopy,
  uncoveredOptions,
  usedQuestionIds,
} from "./flow-edit";

function must(result: { ok: boolean; graph?: FlowGraph; reason?: string }): FlowGraph {
  if (!result.ok || !result.graph) throw new Error(`expected an edit, got: ${result.reason}`);
  return result.graph;
}

const invisalign = (): FlowGraph => templateForGoal("invisalign").build();
const edgeIndexOf = (g: FlowGraph, from: string, to: string): number =>
  g.edges.findIndex((e) => e.from === from && e.to === to);

describe("node ids", () => {
  it("names a new step after its question, and never reuses a taken id", () => {
    const g = invisalign();
    expect(nextNodeId(g, "align_detail")).toBe("q-align_detail");
    expect(nextNodeId(g, "readiness")).toBe("q-readiness-2");
  });
});

describe("reading the graph", () => {
  it("treats the “anything else” wire as the default target, not merely the first one", () => {
    const g: FlowGraph = {
      schemaVersion: 1,
      entry: "a",
      nodes: [
        { id: "a", kind: "question", questionId: Q_TREATMENT },
        { id: "b", kind: "contact" },
        { id: "c", kind: "contact" },
      ],
      edges: [
        { from: "a", to: "b", answer: "implants" },
        { from: "a", to: "c", answer: null },
      ],
    };
    expect(defaultTargetOf(g, "a")).toBe("c");
    expect(defaultTargetOf(g, "b")).toBeNull();
  });

  it("lists the options no wire covers, and nothing once there is a default", () => {
    const g: FlowGraph = {
      schemaVersion: 1,
      entry: "a",
      nodes: [
        { id: "a", kind: "question", questionId: Q_TIMELINE },
        { id: "b", kind: "contact" },
      ],
      edges: [{ from: "a", to: "b", answer: "asap" }],
    };
    expect(uncoveredOptions(g, "a").map((o) => o.value)).toEqual([
      "1_2_months",
      "3_6_months",
      "researching",
    ]);
    const withDefault = must(addEdge(g, "a", "b", null));
    expect(uncoveredOptions(withDefault, "a")).toEqual([]);
  });

  it("reports which bank questions the funnel already uses", () => {
    const used = usedQuestionIds(invisalign());
    expect([...used].sort()).toEqual(
      [Q_TREATMENT, Q_TIMELINE, Q_BUDGET, Q_LOCATION, "smile_concern", "readiness"].sort(),
    );
  });
});

describe("adding a question", () => {
  it("splices the new step into the wire and gives it a default route onward", () => {
    const g = invisalign();
    const i = edgeIndexOf(g, "q-budget_readiness", "q-readiness");
    const next = must(insertQuestionOnEdge(g, i, "experience"));

    expect(next.nodes.some((n) => n.id === "q-experience")).toBe(true);
    expect(next.edges.some((e) => e.from === "q-budget_readiness" && e.to === "q-experience")).toBe(true);
    expect(
      next.edges.some((e) => e.from === "q-experience" && e.to === "q-readiness" && e.answer === null),
    ).toBe(true);
    // The old direct wire is gone, not duplicated.
    expect(next.edges.some((e) => e.from === "q-budget_readiness" && e.to === "q-readiness")).toBe(false);
  });

  it("leaves the original graph untouched, because undo depends on it", () => {
    const g = invisalign();
    const before = JSON.stringify(g);
    const i = edgeIndexOf(g, "q-budget_readiness", "q-readiness");
    insertQuestionOnEdge(g, i, "experience");
    expect(JSON.stringify(g)).toBe(before);
  });

  it("keeps a valid template valid after a legal insertion", () => {
    for (const template of FLOW_TEMPLATES) {
      const g = template.build();
      const i = g.edges.findIndex((e) => e.from === `q-${Q_BUDGET}`);
      const allowed = insertableQuestions(g, i);
      for (const questionId of allowed) {
        const next = must(insertQuestionOnEdge(g, i, questionId));
        const result = validateFlow(next);
        expect(result.ok, `${template.key} + ${questionId}: ${JSON.stringify(result.failures)}`).toBe(
          true,
        );
      }
    }
  });

  it("refuses a question that is not in the bank", () => {
    const g = invisalign();
    const result = insertQuestionOnEdge(g, 0, "how_much_can_you_afford");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not a question in the bank");
  });

  it("refuses a wire that is no longer there", () => {
    expect(insertQuestionOnEdge(invisalign(), 999, "experience").ok).toBe(false);
  });
});

describe("the question picker", () => {
  it("never offers a question the path already asks", () => {
    const g = invisalign();
    const i = edgeIndexOf(g, "q-budget_readiness", "q-readiness");
    const offered = insertableQuestions(g, i);
    for (const asked of usedQuestionIds(g)) {
      expect(offered, `offered "${asked}" twice on one path`).not.toContain(asked);
    }
  });

  it("never offers a treatment-specific question off its own branch", () => {
    const g = invisalign();
    // The trunk is reachable on EVERY treatment answer (the default wire out of
    // the treatment question), so an implant-only question here is nonsense.
    const trunk = edgeIndexOf(g, "q-budget_readiness", "q-readiness");
    expect(insertableQuestions(g, trunk)).not.toContain("implant_scope");
    expect(insertableQuestions(g, trunk)).not.toContain("cosmetic_goal");
    expect(insertableQuestions(g, trunk)).not.toContain("align_detail");
  });

  it("DOES offer a treatment-specific question on the branch it belongs to", () => {
    const g = invisalign();
    const onBranch = edgeIndexOf(g, "q-smile_concern", `q-${Q_TIMELINE}`);
    expect(onBranch).toBeGreaterThanOrEqual(0);
    expect(insertableQuestions(g, onBranch)).toContain("align_detail");
  });

  it("offers nothing once the funnel is at its length cap", () => {
    let g: FlowGraph = buildScratchFlow();
    const at = (): number => g.edges.findIndex((e) => e.from === `q-${Q_BUDGET}`);
    // Fill to the cap using whatever the picker itself allows.
    for (let guard = 0; guard < 20; guard++) {
      const allowed = insertableQuestions(g, at());
      if (allowed.length === 0) break;
      g = must(insertQuestionOnEdge(g, at(), allowed[0]!));
    }
    expect(insertableQuestions(g, at())).toEqual([]);
    expect(validateFlow(g).ok).toBe(true);
  });

  it("returns nothing for a wire that does not exist", () => {
    expect(insertableQuestions(invisalign(), -1)).toEqual([]);
  });
});

describe("removing a step", () => {
  it("re-points everything that led to it at its default target", () => {
    const g = invisalign();
    const next = must(removeNode(g, "q-readiness"));
    expect(next.nodes.some((n) => n.id === "q-readiness")).toBe(false);
    expect(next.edges.some((e) => e.to === "q-readiness" || e.from === "q-readiness")).toBe(false);
    expect(next.edges.some((e) => e.from === `q-${Q_BUDGET}` && e.to === `q-${Q_LOCATION}`)).toBe(true);
    expect(validateFlow(next).ok).toBe(true);
  });

  it("re-points a BRANCH, not only the trunk, so no route is left dangling", () => {
    const g = invisalign();
    const next = must(removeNode(g, "q-smile_concern"));
    // The invisalign answer used to go to the picture question; it must now go
    // wherever that question went, and not into thin air.
    const branch = next.edges.find((e) => e.from === `q-${Q_TREATMENT}` && e.answer === "invisalign");
    expect(branch?.to).toBe(`q-${Q_TIMELINE}`);
    expect(validateFlow(next).ok).toBe(true);
  });

  it("drops a wire that re-pointing would loop back onto its own step", () => {
    // "mid" leads back to "t", so re-pointing t -> mid at mid's default target
    // would make t point at itself: a step that can never be left.
    const g: FlowGraph = {
      schemaVersion: 1,
      entry: "t",
      nodes: [
        { id: "t", kind: "question", questionId: Q_TREATMENT },
        { id: "mid", kind: "question", questionId: Q_TIMELINE },
        { id: "end", kind: "contact" },
      ],
      edges: [
        { from: "t", to: "mid", answer: "implants" },
        { from: "t", to: "end", answer: null },
        { from: "mid", to: "t", answer: null },
      ],
    };
    const next = must(removeNode(g, "mid"));
    expect(next.edges.every((e) => e.from !== e.to), JSON.stringify(next.edges)).toBe(true);
  });

  it("collapses a duplicated answer rather than carrying both wires through the deletion", () => {
    // A graph can arrive here already carrying two wires for one answer - the
    // generator produces JSON and normaliseFlow only checks SHAPE, so rule 3 is
    // what catches it. Deleting a step must not turn one such fault into two.
    const g: FlowGraph = {
      schemaVersion: 1,
      entry: "t",
      nodes: [
        { id: "t", kind: "question", questionId: Q_TREATMENT },
        { id: "mid", kind: "question", questionId: Q_TIMELINE },
        { id: "end", kind: "contact" },
      ],
      edges: [
        { from: "t", to: "mid", answer: "implants" },
        { from: "t", to: "end", answer: "implants" },
        { from: "mid", to: "end", answer: null },
      ],
    };
    const next = must(removeNode(g, "mid"));
    const keys = next.edges.map((e) => `${e.from} ${e.answer}`);
    expect(new Set(keys).size, JSON.stringify(next.edges)).toBe(keys.length);
  });

  it("refuses the steps a funnel cannot do without", () => {
    const g = invisalign();
    for (const [id, fragment] of [
      ["welcome", "opening step"],
      ["contact", "contact step"],
      ["result-high", "all three result steps"],
    ] as const) {
      const result = removeNode(g, id);
      expect(result.ok, `removing ${id} was allowed`).toBe(false);
      if (!result.ok) expect(result.reason).toContain(fragment);
    }
  });

  it("refuses a step that leads nowhere, because there is nothing to re-route onto", () => {
    const g: FlowGraph = {
      schemaVersion: 1,
      entry: "a",
      nodes: [
        { id: "a", kind: "question", questionId: Q_TREATMENT },
        { id: "b", kind: "question", questionId: Q_TIMELINE },
      ],
      edges: [{ from: "a", to: "b", answer: null }],
    };
    const result = removeNode(g, "b");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("leads nowhere");
  });

  it("refuses a step that is no longer there", () => {
    expect(removeNode(invisalign(), "q-nothing").ok).toBe(false);
  });
});

describe("editing wires", () => {
  it("re-points a wire, and refuses to point a step at itself", () => {
    const g = invisalign();
    const i = edgeIndexOf(g, `q-${Q_LOCATION}`, "contact");
    expect(must(setEdgeTarget(g, i, "result-low")).edges[i]!.to).toBe("result-low");
    expect(setEdgeTarget(g, i, `q-${Q_LOCATION}`).ok).toBe(false);
    expect(setEdgeTarget(g, i, "q-nothing").ok).toBe(false);
  });

  it("refuses a second wire claiming an answer the step already routes", () => {
    const g = invisalign();
    const i = edgeIndexOf(g, `q-${Q_TREATMENT}`, `q-${Q_TIMELINE}`); // the default wire
    const result = setEdgeAnswer(g, i, "invisalign"); // already routed to the picture question
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invisalign");
  });

  it("adds and removes a wire, refusing a duplicate default", () => {
    const g = invisalign();
    expect(addEdge(g, `q-${Q_TREATMENT}`, "contact", null).ok).toBe(false);
    const added = must(addEdge(g, `q-${Q_TREATMENT}`, "contact", "other"));
    expect(added.edges).toHaveLength(g.edges.length + 1);
    expect(must(removeEdge(added, added.edges.length - 1)).edges).toHaveLength(g.edges.length);
    expect(removeEdge(g, 999).ok).toBe(false);
  });
});

describe("editing patient-facing copy", () => {
  it("stores a trimmed line and drops a cleared one entirely", () => {
    const g = invisalign();
    const set = must(setQuestionTransition(g, `q-${Q_TIMELINE}`, "  Nearly there.  "));
    const node = set.nodes.find((n) => n.id === `q-${Q_TIMELINE}`)!;
    expect(node.kind === "question" && node.transition).toBe("Nearly there.");

    const cleared = must(setQuestionTransition(set, `q-${Q_TIMELINE}`, "   "));
    const after = cleared.nodes.find((n) => n.id === `q-${Q_TIMELINE}`)!;
    expect(after.kind === "question" && "transition" in after).toBe(false);
  });

  it("caps every authored line at the stored limit, so a save cannot be refused for length", () => {
    const g = invisalign();
    const long = "a".repeat(500);
    const t = must(setEdgeTransition(g, 0, long)).edges[0]!;
    expect(t.transition!.length).toBe(FLOW_LIMITS.transition);
    const h = must(setOutcomeHeadline(g, "result-high", long)).nodes.find((n) => n.id === "result-high")!;
    expect(h.kind === "outcome" && h.headline!.length).toBe(FLOW_LIMITS.headline);
    const w = must(setWelcomeCopy(g, "welcome", long, long)).nodes.find((n) => n.id === "welcome")!;
    expect(w.kind === "welcome" && w.headline!.length).toBe(FLOW_LIMITS.headline);
    expect(w.kind === "welcome" && w.intro!.length).toBe(FLOW_LIMITS.intro);
  });

  it("keeps the band on a result step when its headline changes", () => {
    const g = invisalign();
    const next = must(setOutcomeHeadline(g, "result-low", "Thank you for your time."));
    const node = next.nodes.find((n) => n.id === "result-low")!;
    expect(node.kind === "outcome" && node.band).toBe("low");
    expect(validateFlow(next).ok).toBe(true);
  });

  it("refuses to write copy onto the wrong kind of step", () => {
    const g = invisalign();
    expect(setQuestionTransition(g, "contact", "hello").ok).toBe(false);
    expect(setOutcomeHeadline(g, `q-${Q_TIMELINE}`, "hello").ok).toBe(false);
    expect(setWelcomeCopy(g, "contact", "a", "b").ok).toBe(false);
  });
});

describe("what a card says", () => {
  it("shows a question's real prompt and every one of its option labels", () => {
    const card = describeNode({ id: "x", kind: "question", questionId: Q_TIMELINE });
    expect(card.eyebrow).toBe("Question");
    expect(card.title).toBe("How soon would you like to get started?");
    expect(card.options).toEqual([
      "As soon as possible",
      "In the next month or two",
      "In the next few months",
      "Just researching for now",
    ]);
  });

  it("names a question that has left the bank instead of drawing a blank card", () => {
    const card = describeNode({ id: "x", kind: "question", questionId: "gone" });
    expect(card.title).toContain("gone");
    expect(card.options).toEqual([]);
  });

  it("prefers the authored headline on a result step, and falls back to the band", () => {
    expect(describeNode({ id: "r", kind: "outcome", band: "high", headline: "Lovely." }).title).toBe(
      "Lovely.",
    );
    const bare = describeNode({ id: "r", kind: "outcome", band: "low" });
    expect(bare.title).toBe("Early enquiry");
    expect(bare.eyebrow).toContain("Low");
  });

  it("labels a wire by its OPTION LABEL, never by the raw stored value", () => {
    const from = { id: "t", kind: "question", questionId: Q_TREATMENT } as const;
    expect(describeEdge({ from: "t", to: "x", answer: "invisalign" }, from)).toBe(
      "Straightening my teeth (Invisalign)",
    );
    expect(describeEdge({ from: "t", to: "x", answer: null }, from)).toBe("Anything else");
    expect(describeEdge({ from: "t", to: "x", answer: "sedation" }, from)).toContain("Not an option");
  });

  it("labels a wire out of the contact step by its band, because that is what routes it", () => {
    const contact = { id: "c", kind: "contact" } as const;
    expect(describeEdge({ from: "c", to: "r", answer: "high" }, contact)).toBe("High intent");
    expect(describeEdge({ from: "c", to: "r", answer: "asap" }, contact)).toContain("Not a result");
  });

  it("leaves the welcome wire unlabelled: nothing has been answered yet", () => {
    expect(describeEdge({ from: "w", to: "a", answer: null }, { id: "w", kind: "welcome" })).toBeUndefined();
  });

  it("offers a question's options to route on, and the three bands out of contact", () => {
    expect(routableAnswers({ id: "c", kind: "contact" }).map((a) => a.value)).toEqual([
      "high",
      "medium",
      "low",
    ]);
    expect(routableAnswers({ id: "q", kind: "question", questionId: Q_LOCATION }).map((a) => a.value)).toEqual([
      "england",
      "scotland",
      "elsewhere",
    ]);
    expect(routableAnswers({ id: "w", kind: "welcome" })).toEqual([]);
  });
});
