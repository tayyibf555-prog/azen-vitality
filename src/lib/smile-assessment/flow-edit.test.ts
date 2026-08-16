import { describe, it, expect } from "vitest";
import {
  FLOW_BANDS,
  FLOW_BLOCK_KINDS,
  FLOW_LIMITS,
  blockCopyFields,
  normaliseFlow,
  type FlowBlock,
  type FlowEdge,
  type FlowGraph,
} from "./flow";
import { validateFlow } from "./flow-validate";
import { scanFlowCopy } from "./flow-copy";
import { nextNode } from "./flow-runtime";
import { FLOW_TEMPLATES, buildScratchFlow, templateForGoal } from "./flow-templates";
import { Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT } from "./quiz";
import { assessImagesForSlot } from "@/lib/assess/image-library";
import {
  addBlock,
  addBlockChip,
  addBlockFaqItem,
  addableBlockKinds,
  moveBlock,
  optionImageRows,
  questionSwapWarning,
  removeBlock,
  removeBlockItem,
  removeOptionImage,
  setBlockImage,
  setBlockText,
  setOptionImage,
  starterBlock,
  addEdge,
  connectableTargets,
  defaultEdgeOf,
  defaultTargetOf,
  describeEdge,
  describeNode,
  moveEdge,
  outgoingEdges,
  planScreenInsertion,
  routableAnswers,
  routedAnswers,
  insertQuestionOnEdge,
  insertableQuestions,
  insertableQuestionsAfter,
  nextNodeId,
  removeEdge,
  removeNode,
  setEdgeAnswer,
  setEdgeTarget,
  setEdgeTransition,
  setNodeQuestion,
  setOutcomeHeadline,
  setQuestionTransition,
  setWelcomeCopy,
  swappableQuestions,
  uncoveredAnswers,
  usedQuestionIds,
} from "./flow-edit";

function must(result: { ok: boolean; graph?: FlowGraph; reason?: string }): FlowGraph {
  if (!result.ok || !result.graph) throw new Error(`expected an edit, got: ${result.reason}`);
  return result.graph;
}

const invisalign = (): FlowGraph => templateForGoal("invisalign").build();
const edgeIndexOf = (g: FlowGraph, from: string, to: string): number =>
  g.edges.findIndex((e) => e.from === from && e.to === to);

/** Order-independent identity of a wire, for comparing two edge lists as SETS. */
const wireKey = (e: FlowEdge): string => `${e.from}|${e.to}|${e.answer ?? ""}`;
const byWire = (a: FlowEdge, b: FlowEdge): number => wireKey(a).localeCompare(wireKey(b));

/** Where these answers actually land a patient, through the real runtime. */
const walkTo = (graph: FlowGraph, answers: Record<string, string>): string | null =>
  nextNode(graph, answers)?.id ?? null;

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
    // The WIRE, not merely its destination: "add a screen after this one" splices
    // into an edge index, so the fallback rule has to hand one back.
    expect(defaultEdgeOf(g, "a")?.index).toBe(1);
    expect(defaultEdgeOf(g, "b")).toBeNull();
  });

  // MUTATION: take the first wire rather than the "anything else" one and every
  // insertion on a branched step lands on the branch instead of the trunk.
  it("falls back to the first wire only when there is no “anything else” one", () => {
    const g = invisalign();
    // q-treatment_interest routes "invisalign" first, then the default.
    const branched = outgoingEdges(g, "q-treatment_interest");
    expect(branched[0]!.edge.answer).toBe("invisalign");
    expect(defaultEdgeOf(g, "q-treatment_interest")!.index).toBe(branched[1]!.index);
    expect(defaultTargetOf(g, "q-treatment_interest")).toBe("q-timeline");
  });

  it("lists the answers no wire covers, and nothing once there is a default", () => {
    const g: FlowGraph = {
      schemaVersion: 1,
      entry: "a",
      nodes: [
        { id: "a", kind: "question", questionId: Q_TIMELINE },
        { id: "b", kind: "contact" },
      ],
      edges: [{ from: "a", to: "b", answer: "asap" }],
    };
    expect(uncoveredAnswers(g, "a").map((o) => o.value)).toEqual([
      "1_2_months",
      "3_6_months",
      "researching",
    ]);
    const withDefault = must(addEdge(g, "a", "b", null));
    expect(uncoveredAnswers(withDefault, "a")).toEqual([]);
  });

  /**
   * THE HOLE WITH NO FLOOR UNDER IT, before A1's parity pass: this returned
   * question options only, so deleting a band route out of the contact step left
   * rule 3 shouting in the banner with no control anywhere that could put the wire
   * back - and the rail's Trash button is what deleted it.
   *
   * MUTATION: scope this to `kind === "question"` again and the funnel below can be
   * broken from the rail and repaired from nowhere.
   */
  it("lists an uncovered BAND on the contact step, exactly as rule 3 reports it", () => {
    const g = invisalign();
    const high = g.edges.findIndex((e) => e.from === "contact" && e.answer === "high");
    const broken = must(removeEdge(g, high));

    const failures = validateFlow(broken).failures;
    expect(failures.some((f) => f.code === "band_uncovered" && f.where === "contact")).toBe(true);

    expect(uncoveredAnswers(broken, "contact").map((a) => a.value)).toEqual(["high"]);
    // ...and routing it is a real repair: the band failure goes.
    const routed = must(addEdge(broken, "contact", defaultTargetOf(broken, "contact")!, "high"));
    expect(validateFlow(routed).failures.some((f) => f.code === "band_uncovered")).toBe(false);
  });

  it("offers no uncovered answers on the kinds that route on none", () => {
    const g = invisalign();
    expect(uncoveredAnswers(g, "welcome")).toEqual([]);
    expect(uncoveredAnswers(g, "result-high")).toEqual([]);
    expect(uncoveredAnswers(g, "nope")).toEqual([]);
  });

  // MUTATION: drop the self filter in one of the three destination pickers and a
  // control offers a step a route to itself, which setEdgeTarget then refuses.
  it("offers every step but this one as a destination", () => {
    const g = invisalign();
    const ids = connectableTargets(g, "contact").map((n) => n.id);
    expect(ids).not.toContain("contact");
    expect(ids).toHaveLength(g.nodes.length - 1);
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

/* ---------------------------------------------------------------------------
 * CHANGING THE QUESTION A STEP ASKS (A1). The move the phone-canvas inspector is
 * built around: the screen stays where it is, the ask on it changes.
 * ------------------------------------------------------------------------- */

describe("swapping the question on a step", () => {
  // MUTATION: implement the swap as remove-then-insert and the step loses its
  // place - removeNode re-points everything that led to it and drops everything
  // it led to, which is precisely what the owner did NOT ask to change.
  it("keeps the step's id, its wires and its lead-in line", () => {
    const g = must(setQuestionTransition(invisalign(), "q-smile_concern", "One more about your smile."));
    const next = must(setNodeQuestion(g, "q-smile_concern", "align_detail"));
    const node = next.nodes.find((n) => n.id === "q-smile_concern");

    expect(node?.kind === "question" ? node.questionId : null).toBe("align_detail");
    expect(node?.kind === "question" ? node.transition : null).toBe("One more about your smile.");
    expect(next.edges).toEqual(g.edges);
    expect(validateFlow(next).ok).toBe(true);
  });

  // MUTATION: carry `optionImages` across "so nothing is lost". Every one of them
  // names an option VALUE of the question that just left, so rule 14 fails on all
  // of them and the answer grid renders ragged until the owner finds out why.
  it("drops answer-card pictures, which belong to the question that left", () => {
    const g = invisalign();
    const withImages: FlowGraph = {
      ...g,
      schemaVersion: 2,
      nodes: g.nodes.map((n) =>
        n.id === "q-smile_concern"
          ? { id: n.id, kind: "question", questionId: "smile_concern", optionImages: [{ value: "crooked", image: "conditions/crooked" }] }
          : n,
      ),
    };
    const next = must(setNodeQuestion(withImages, "q-smile_concern", "align_detail"));
    const node = next.nodes.find((n) => n.id === "q-smile_concern");
    expect(node?.kind === "question" ? node.optionImages : "n/a").toBeUndefined();
  });

  // MUTATION: allow the swap on a branched step. Every wire out of it carries an
  // option value of the OLD question, so the funnel is instantly rule-2 broken -
  // and the two "obvious" repairs (drop those wires, or collapse them onto one
  // target) both destroy routing the owner built by hand.
  it("refuses on a step whose answers are routed one by one, and says what to do", () => {
    const g = invisalign();
    // The treatment step sends "invisalign" its own way.
    expect(routedAnswers(g, "q-treatment_interest").length).toBe(1);
    const result = setNodeQuestion(g, "q-treatment_interest", "motivation");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Point it the same way");
    // ...and the picker offers nothing but the question it already asks.
    expect(swappableQuestions(g, "q-treatment_interest")).toEqual(["treatment_interest"]);
  });

  it("refuses an unknown question, a step that is not a question, and a step that has gone", () => {
    const g = invisalign();
    expect(setNodeQuestion(g, "q-timeline", "how_much_can_you_afford").ok).toBe(false);
    expect(setNodeQuestion(g, "contact", "motivation").ok).toBe(false);
    expect(setNodeQuestion(g, "nope", "motivation").ok).toBe(false);
  });

  it("is a no-op for the question already there, and never mutates its input", () => {
    const g = invisalign();
    const before = JSON.stringify(g);
    expect(must(setNodeQuestion(g, "q-timeline", Q_TIMELINE))).toEqual(g);
    setNodeQuestion(g, "q-smile_concern", "align_detail");
    expect(JSON.stringify(g)).toBe(before);
  });
});

describe("the swap picker", () => {
  // MUTATION: derive the list ("every bank question not already used") instead of
  // asking the validator, and it offers a treatment-specific question on the
  // trunk, or one that makes the funnel too long - the same second copy of the
  // rules insertableQuestions exists to avoid.
  it("offers only swaps that leave the funnel publishable", () => {
    for (const template of FLOW_TEMPLATES) {
      const g = template.build();
      for (const node of g.nodes) {
        if (node.kind !== "question") continue;
        for (const questionId of swappableQuestions(g, node.id)) {
          const next = must(setNodeQuestion(g, node.id, questionId));
          const result = validateFlow(next);
          expect(result.ok, `${template.key}/${node.id} -> ${questionId}: ${JSON.stringify(result.failures)}`).toBe(true);
        }
      }
    }
  });

  // MUTATION: leave the current question out and the picker renders showing
  // somebody else's question as this step's own.
  it("always includes the question the step already asks", () => {
    const g = invisalign();
    for (const node of g.nodes) {
      if (node.kind !== "question") continue;
      expect(swappableQuestions(g, node.id), node.id).toContain(node.questionId);
    }
  });

  it("never offers a question the path already asks", () => {
    const g = invisalign();
    const offered = swappableQuestions(g, "q-readiness");
    for (const asked of usedQuestionIds(g)) {
      if (asked === "readiness") continue; // its own, which must be there
      expect(offered, `offered "${asked}" twice on one path`).not.toContain(asked);
    }
    // ...and it really does offer alternatives, or this proves nothing.
    expect(offered.length).toBeGreaterThan(1);
  });

  it("offers nothing for a step that is not a question, or is not there", () => {
    expect(swappableQuestions(invisalign(), "contact")).toEqual([]);
    expect(swappableQuestions(invisalign(), "nope")).toEqual([]);
  });
});

describe("reading a step's wires", () => {
  // MUTATION: re-derive the index in the component with a second findIndex and
  // the first two wires out of one step that share a target become the same
  // wire - so editing one re-points the other.
  it("carries the index into graph.edges with every outgoing wire", () => {
    const g = invisalign();
    const out = outgoingEdges(g, "q-treatment_interest");
    expect(out.length).toBe(2);
    for (const { index, edge } of out) expect(g.edges[index]).toBe(edge);
    // Declaration order, which is what makes the walk deterministic.
    expect(out.map(({ edge }) => edge.answer)).toEqual(["invisalign", null]);
    expect(outgoingEdges(g, "result-high")).toEqual([]);

    // THE CASE THE SECOND findIndex GETS WRONG: two answers out of one step,
    // pointed at the SAME screen. Matching on from+to hands back the first
    // index twice, so editing the second row re-points the first.
    const shared: FlowGraph = {
      ...g,
      edges: [
        { from: "q-timeline", to: "contact", answer: "asap" },
        { from: "q-timeline", to: "contact", answer: null },
      ],
    };
    const rows = outgoingEdges(shared, "q-timeline");
    expect(rows.map(({ index }) => index)).toEqual([0, 1]);
    for (const { index, edge } of rows) expect(shared.edges[index]).toBe(edge);
  });

  it("separates the answers routed on their own from the default route", () => {
    const g = invisalign();
    expect(routedAnswers(g, "q-treatment_interest").map(({ edge }) => edge.answer)).toEqual([
      "invisalign",
    ]);
    expect(routedAnswers(g, "q-timeline")).toEqual([]);
    // The contact step routes all three bands one by one.
    expect(routedAnswers(g, "contact").map(({ edge }) => edge.answer)).toEqual([...FLOW_BANDS]);
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

/* ---------------------------------------------------------------------------
 * REORDERING THE BRANCHES OUT OF A STEP.
 * ------------------------------------------------------------------------- */

describe("moving a wire among its siblings", () => {
  it("swaps it with the neighbouring wire out of the SAME step, and moves nothing else", () => {
    const g = invisalign();
    const before = outgoingEdges(g, `q-${Q_TREATMENT}`);
    expect(before.map(({ edge }) => edge.answer)).toEqual(["invisalign", null]);

    const moved = must(moveEdge(g, before[0]!.index, +1));
    expect(outgoingEdges(moved, `q-${Q_TREATMENT}`).map(({ edge }) => edge.answer)).toEqual([
      null,
      "invisalign",
    ]);
    // Same wires, same count: a reorder is not a rewrite.
    expect(moved.edges).toHaveLength(g.edges.length);
    expect([...moved.edges].sort(byWire)).toEqual([...g.edges].sort(byWire));
    // And every OTHER step's wires are where they were.
    for (const id of ["welcome", "contact", `q-${Q_TIMELINE}`]) {
      expect(outgoingEdges(moved, id)).toEqual(outgoingEdges(g, id));
    }
    expect(g.edges[before[0]!.index]!.answer, "the input was mutated").toBe("invisalign");
  });

  // MUTATION: let it walk past the ends and the last row's "down" silently swaps
  // with a wire out of a DIFFERENT step - which re-points two branches at once.
  it("refuses at either end, in words", () => {
    const g = invisalign();
    const [first, last] = outgoingEdges(g, `q-${Q_TREATMENT}`);
    const up = moveEdge(g, first!.index, -1);
    const down = moveEdge(g, last!.index, +1);
    expect(up.ok).toBe(false);
    expect(down.ok).toBe(false);
    if (!up.ok) expect(up.reason).toContain("first");
    if (!down.ok) expect(down.reason).toContain("last");
    expect(moveEdge(g, 999, +1).ok).toBe(false);
  });

  /**
   * WHAT REORDERING MEANS, held so the claim in the op's header cannot rot: the
   * picture and the fallback change, the ROUTE a patient takes does not.
   * routeFor matches the answer exactly before it falls back (flow-runtime.ts:64).
   */
  it("changes the fallback wire but never which answer wins", () => {
    const g: FlowGraph = {
      schemaVersion: 1,
      entry: "a",
      nodes: [
        { id: "a", kind: "question", questionId: Q_TIMELINE },
        { id: "b", kind: "contact" },
        { id: "c", kind: "contact" },
      ],
      // No default wire at all, so defaultEdgeOf falls back to the FIRST.
      edges: [
        { from: "a", to: "b", answer: "asap" },
        { from: "a", to: "c", answer: "researching" },
      ],
    };
    expect(defaultTargetOf(g, "a")).toBe("b");
    const moved = must(moveEdge(g, 0, +1));
    expect(defaultTargetOf(moved, "a")).toBe("c");
    // Both orders still route both answers the same way.
    for (const graph of [g, moved]) {
      expect(walkTo(graph, { [Q_TIMELINE]: "asap" })).toBe("b");
      expect(walkTo(graph, { [Q_TIMELINE]: "researching" })).toBe("c");
    }
  });
});

/* ---------------------------------------------------------------------------
 * "ADD A SCREEN AFTER THIS ONE" - the + on the strip, resolved.
 * ------------------------------------------------------------------------- */

describe("planning a screen insertion", () => {
  it("lands on the step's fallback wire and names the step it will create", () => {
    const g = invisalign();
    const plan = planScreenInsertion(g, `q-${Q_TIMELINE}`, "experience");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(g.edges[plan.edgeIndex]).toEqual({
      from: `q-${Q_TIMELINE}`,
      to: `q-${Q_BUDGET}`,
      answer: null,
    });
    expect(plan.nodeId).toBe("q-experience");

    // THE PLAN IS THE EDIT. The id it promised is the id the op creates, because
    // both call nextNodeId on this same graph - which is the whole reason the
    // builder can select the new screen without re-reading the result.
    const next = must(insertQuestionOnEdge(g, plan.edgeIndex, plan.questionId));
    expect(next.nodes.some((n) => n.id === plan.nodeId)).toBe(true);
  });

  it("takes the first question it may offer when none is named", () => {
    const g = invisalign();
    const offered = insertableQuestionsAfter(g, `q-${Q_TIMELINE}`);
    expect(offered.length).toBeGreaterThan(0);
    const plan = planScreenInsertion(g, `q-${Q_TIMELINE}`);
    expect(plan.ok && plan.questionId).toBe(offered[0]);
  });

  // MUTATION: skip the membership check and the one-click + can drop a question
  // that rule 8, 9 or 10 forbids straight into the funnel - the picker's rule
  // exists precisely because the + has no picker to show it in.
  it("refuses a question the validator would not offer here, and says why", () => {
    const g = invisalign();
    const offered = insertableQuestionsAfter(g, `q-${Q_TIMELINE}`);
    // Already asked on this route: rule 8.
    expect(offered).not.toContain(Q_TIMELINE);
    const plan = planScreenInsertion(g, `q-${Q_TIMELINE}`, Q_TIMELINE);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("already asked");
    // Not in the bank at all.
    expect(planScreenInsertion(g, `q-${Q_TIMELINE}`, "not_a_question").ok).toBe(false);
  });

  /**
   * RULE 10 REACHES THE + WITHOUT THE + KNOWING IT EXISTS. Swapping a core question
   * away is refused by the swap picker; ADDING must equally never be the thing that
   * takes the funnel below the core three. The insertion list is the validator's
   * answer, so this holds whatever rule 10 becomes.
   */
  it("never offers an insertion that introduces a new kind of failure", () => {
    const g = invisalign();
    const clean = validateFlow(g);
    expect(clean.ok).toBe(true);
    for (const node of g.nodes) {
      for (const qid of insertableQuestionsAfter(g, node.id)) {
        const plan = planScreenInsertion(g, node.id, qid);
        expect(plan.ok, `${node.id} offered ${qid} and then refused it`).toBe(true);
        if (!plan.ok) continue;
        const next = must(insertQuestionOnEdge(g, plan.edgeIndex, plan.questionId));
        expect(validateFlow(next).ok, `${qid} after ${node.id} broke the funnel`).toBe(true);
      }
    }
  });

  it("refuses on a dead end, pointing at the connection that is missing", () => {
    const g = invisalign();
    // A result step is terminal by rule 7, so it has no wire to splice into.
    const terminal = planScreenInsertion(g, "result-high");
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.reason).toContain("Connect it first");
    expect(insertableQuestionsAfter(g, "result-high")).toEqual([]);
    expect(planScreenInsertion(g, "gone").ok).toBe(false);
  });

  // Keep adding after the opening screen until the picker has nothing left - which
  // it always reaches, because every question it may add is one it may not add
  // twice (rule 8) and the funnel has a length cap (rule 4b).
  it("refuses when the route is full, rather than offering an empty picker", () => {
    let full = invisalign();
    let added = 0;
    for (let guard = 0; guard < FLOW_LIMITS.nodes; guard++) {
      const plan = planScreenInsertion(full, "welcome");
      if (!plan.ok) break;
      full = must(insertQuestionOnEdge(full, plan.edgeIndex, plan.questionId));
      added++;
    }
    expect(added, "nothing was ever insertable, so this proves nothing").toBeGreaterThan(0);
    expect(insertableQuestionsAfter(full, "welcome")).toEqual([]);

    const plan = planScreenInsertion(full, "welcome");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain("Nothing left to add");
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

  // Each editor REBUILDS its node field by field rather than spreading, which is
  // what stops a removed field surviving in a stored row - and is exactly what
  // would quietly delete an owner's content blocks when they later fix a typo on
  // the same screen. The save would report success. Nothing would say otherwise.
  it("keeps the content blocks on a screen whose copy is edited", () => {
    const strip: FlowBlock = {
      kind: "trust-strip",
      practiceName: "Vitality Dental",
      chips: ["Open Saturdays"],
    };
    const quote: FlowBlock = {
      kind: "testimonial",
      quote: "The team explained every step and I never felt rushed.",
      attribution: "Hannah, Enfield",
    };

    const g = invisalign();
    const withFurniture: FlowGraph = {
      ...g,
      nodes: g.nodes.map((n) => {
        if (n.id === "welcome" && n.kind === "welcome") return { ...n, blocks: [strip] };
        if (n.id === "result-high" && n.kind === "outcome") return { ...n, blocks: [quote] };
        return n;
      }),
    };

    const edited = must(setWelcomeCopy(withFurniture, "welcome", "A warm hello", "One or two questions."));
    const welcome = edited.nodes.find((n) => n.id === "welcome")!;
    expect(welcome.kind === "welcome" && welcome.blocks).toEqual([strip]);

    const after = must(setOutcomeHeadline(edited, "result-high", "You look ready to get started."));
    const result = after.nodes.find((n) => n.id === "result-high")!;
    expect(result.kind === "outcome" && result.blocks).toEqual([quote]);
    expect(validateFlow(after).ok).toBe(true);
  });

  it("keeps the answer pictures on a question whose lead-in is edited", () => {
    const optionImages = [
      { value: "asap", image: "conditions/crowded" },
      { value: "1_2_months", image: "conditions/gaps" },
      { value: "3_6_months", image: "conditions/overbite" },
      { value: "researching", image: "conditions/underbite" },
    ];
    const g = invisalign();
    const pictured: FlowGraph = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === `q-${Q_TIMELINE}` && n.kind === "question" ? { ...n, optionImages } : n,
      ),
    };
    const edited = must(setQuestionTransition(pictured, `q-${Q_TIMELINE}`, "Nearly there."));
    const node = edited.nodes.find((n) => n.id === `q-${Q_TIMELINE}`)!;
    expect(node.kind === "question" && node.optionImages).toEqual(optionImages);
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

  // MUTATION: this is the defect the rows exist for. Every kind but "question"
  // used to return no rows at all, so three quarters of a funnel drew as a title
  // in an empty rectangle and the canvas could not be read without opening each
  // step in turn. Held over every real template, so a new template kind cannot
  // reintroduce a blank card.
  it("gives EVERY step something to read, not only the questions", () => {
    for (const template of [...FLOW_TEMPLATES, { key: "scratch", build: buildScratchFlow }]) {
      for (const node of template.build().nodes) {
        const card = describeNode(node);
        expect(card.title.length, `${template.key}/${node.id} has no title`).toBeGreaterThan(0);
        expect(card.options.length, `${template.key}/${node.id} draws as an empty box`).toBeGreaterThan(0);
      }
    }
  });

  // MUTATION: transpose or drop one of these and the card promises the practice a
  // field the funnel never asks for. They are the three the public funnel really
  // captures (deterministic-assessment-quiz.tsx:717-771).
  it("lists what the contact step captures, in the order it is asked for", () => {
    const card = describeNode({ id: "c", kind: "contact" });
    expect(card.eyebrow).toBe("Capture");
    expect(card.title).toBe("Contact details");
    expect(card.options).toEqual(["First name", "How to reach you", "Mobile or email"]);
  });

  it("hands out a fresh row list, so a caller cannot edit the next card's rows", () => {
    const first = describeNode({ id: "c", kind: "contact" });
    first.options.push("National Insurance number");
    expect(describeNode({ id: "c2", kind: "contact" }).options).toEqual([
      "First name",
      "How to reach you",
      "Mobile or email",
    ]);
  });

  // MUTATION: drop the intro row and the opening line an owner authored is
  // invisible on the canvas - the one screen it is supposed to be reviewed on.
  it("shows the welcome step's own opening line, and says where it lands", () => {
    const authored = describeNode({
      id: "w",
      kind: "welcome",
      headline: "Is Invisalign right for you?",
      intro: "Answer a few quick questions.",
    });
    expect(authored.title).toBe("Is Invisalign right for you?");
    expect(authored.options[0]).toBe("Answer a few quick questions.");
    expect(authored.options[1]).toBe("Sits above the first question");

    // Nothing authored: the card says which copy is actually running, rather
    // than leaving a blank row where the intro would have been.
    const bare = describeNode({ id: "w", kind: "welcome" });
    expect(bare.title).toBe("Welcome screen");
    expect(bare.options[0]).toBe("Uses the assessment’s own intro");
    expect(bare.options).toHaveLength(authored.options.length);
  });

  // MUTATION: copy one band's line onto another and the three result steps stop
  // being distinguishable at a glance, which is the whole reason there are three.
  it("says what happens next on a result step, differently for each band", () => {
    const lines = FLOW_BANDS.map((band) => describeNode({ id: `r-${band}`, kind: "outcome", band }));
    for (const card of lines) expect(card.options).toHaveLength(1);
    expect(lines[0]!.options[0]).toBe("Contacted straight away");
    expect(new Set(lines.map((c) => c.options[0])).size).toBe(FLOW_BANDS.length);
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

/* ---------------------------------------------------------------------------
 * CONTENT BLOCKS (A2's builder half).
 *
 * The rules under the rail's block section. Two of them are invisible until they
 * are broken in production: a graph these ops built must still be READABLE (one
 * blank string makes the whole save come back as "could not be read as a graph"),
 * and adding content to a funnel drawn before A2 must bump its schema version or
 * rule 1 refuses the save with the graph itself perfectly fine.
 * ------------------------------------------------------------------------- */

const welcomeBlocksOf = (g: FlowGraph): FlowBlock[] => {
  const n = g.nodes.find((x) => x.id === "welcome");
  return n && n.kind === "welcome" ? (n.blocks ?? []) : [];
};

const faqBlock = (): FlowBlock => {
  const b = starterBlock("faq");
  if (!b) throw new Error("no faq starter");
  return b;
};

const refusal = (result: { ok: boolean; reason?: string }): string => {
  if (result.ok) throw new Error("expected a refusal, got an edited graph");
  return result.reason ?? "";
};

/** An op run against a copy, so "the input was not touched" is checkable. */
function untouched(graph: FlowGraph, run: (g: FlowGraph) => unknown): void {
  const before = JSON.stringify(graph);
  run(graph);
  expect(JSON.stringify(graph), "the draft graph was mutated in place").toBe(before);
}

describe("adding a content block", () => {
  it("puts a starter block on the welcome screen and leaves the funnel publishable", () => {
    const g = must(addBlock(invisalign(), "welcome", faqBlock()));
    const blocks = welcomeBlocksOf(g);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("faq");
    expect(validateFlow(g).ok).toBe(true);
  });

  // MUTATION: drop withRequiredSchemaVersion from withBlocks and this goes red -
  // the graph is perfect and rule 1 refuses the save as `schema_version_too_old`,
  // which reads to an owner as the funnel being broken by adding a block to it.
  it("bumps a pre-A2 funnel's schema version, because content it cannot declare is content an older reader would strip", () => {
    const v1: FlowGraph = { ...invisalign(), schemaVersion: 1 };
    expect(validateFlow(v1).ok).toBe(true);

    const g = must(addBlock(v1, "welcome", faqBlock()));
    expect(g.schemaVersion).toBe(2);
    expect(validateFlow(g).ok).toBe(true);
  });

  // MUTATION: let a second block of one kind through and rule 12's
  // block_duplicate_kind fires on a funnel the owner cannot publish, from a picker
  // that offered the kind.
  it("refuses a second block of the same kind, and stops offering that kind", () => {
    const g = must(addBlock(invisalign(), "welcome", faqBlock()));
    expect(refusal(addBlock(g, "welcome", faqBlock()))).toContain("already has");
    expect(addableBlockKinds(g, "welcome")).not.toContain("faq");
    expect(addableBlockKinds(invisalign(), "welcome")).toContain("faq");
  });

  it("refuses a screen that is an ask or a form, and says which screens take blocks", () => {
    const g = invisalign();
    expect(refusal(addBlock(g, "q-timeline", faqBlock()))).toContain("opening screen or a result screen");
    expect(refusal(addBlock(g, "contact", faqBlock()))).toContain("opening screen or a result screen");
    expect(addableBlockKinds(g, "q-timeline")).toEqual([]);
    expect(addableBlockKinds(g, "contact")).toEqual([]);
    expect(addableBlockKinds(g, "nowhere")).toEqual([]);
  });

  // MUTATION: accept a block with a blank line and the SAVE fails with rule 0
  // ("the funnel could not be read as a graph") - a message about nothing an
  // owner can find, from a control that reported success.
  it("refuses a block with a line left blank, naming the line", () => {
    const g = invisalign();
    const blank: FlowBlock = { kind: "testimonial", quote: "  ", attribution: "Jane" };
    expect(refusal(addBlock(g, "welcome", blank))).toContain("quote");
    expect(normaliseFlow(JSON.parse(JSON.stringify(g)))).not.toBeNull();
  });

  it("stops offering kinds once the screen is full", () => {
    let g = invisalign();
    for (const kind of FLOW_BLOCK_KINDS) {
      const block =
        kind === "testimonial"
          ? ({ kind: "testimonial", quote: "They explained every step.", attribution: "Jo B." } as FlowBlock)
          : starterBlock(kind, "Vitality Dental");
      if (!block) throw new Error(`no starter for ${kind}`);
      g = must(addBlock(g, "welcome", block));
    }
    expect(welcomeBlocksOf(g)).toHaveLength(FLOW_LIMITS.blocksPerNode);
    expect(addableBlockKinds(g, "welcome")).toEqual([]);
    expect(validateFlow(g).ok).toBe(true);
  });
});

describe("what a new block starts as", () => {
  // THE CHARTER RULE, MADE STRUCTURAL. AI never invents a testimonial - and
  // neither does the starter. MUTATION: return a placeholder quote here and the
  // funnel can be published with words no patient ever said.
  it("has no starter for a testimonial, ever: the quote is the practice's own words", () => {
    expect(starterBlock("testimonial")).toBeNull();
    expect(starterBlock("testimonial", "Vitality Dental")).toBeNull();
  });

  it("needs the practice's name before it can start a trust strip", () => {
    expect(starterBlock("trust-strip")).toBeNull();
    expect(starterBlock("trust-strip", "   ")).toBeNull();
    expect(starterBlock("trust-strip", "Vitality Dental")).toEqual({
      kind: "trust-strip",
      practiceName: "Vitality Dental",
      chips: ["Takes about 30 seconds"],
    });
  });

  it("starts a picture on a real manifest key, with the manifest's own description", () => {
    const first = assessImagesForSlot("hero")[0]!;
    expect(starterBlock("image")).toEqual({ kind: "image", image: first.key, alt: first.alt });
  });

  // Every seeded line is patient-facing copy that the server scans at write time.
  // A starter that cannot be published is a starter that breaks the first save.
  it("seeds only copy a funnel is allowed to publish", () => {
    let g = invisalign();
    g = must(addBlock(g, "welcome", faqBlock()));
    g = must(addBlock(g, "welcome", starterBlock("trust-strip", "Vitality Dental")!));
    g = must(addBlock(g, "welcome", starterBlock("image")!));
    expect(validateFlow(g).ok).toBe(true);
    expect(scanFlowCopy(g)).toEqual([]);
  });
});

describe("editing a block's copy", () => {
  it("writes one field and leaves every other line of the screen alone", () => {
    const g = must(addBlock(invisalign(), "welcome", faqBlock()));
    const before = welcomeBlocksOf(g)[0]!;
    const after = welcomeBlocksOf(
      must(setBlockText(g, "welcome", 0, "items[1].a", "  We call you back the same day.  ")),
    )[0]!;
    expect(after.kind === "faq" ? after.items[1]!.a : null).toBe("We call you back the same day.");
    expect(after.kind === "faq" ? after.items[1]!.q : null).toBe(
      before.kind === "faq" ? before.items[1]!.q : "x",
    );
    expect(after.kind === "faq" ? after.items[0] : null).toEqual(
      before.kind === "faq" ? before.items[0] : null,
    );
  });

  it("caps a line at the limit blockCopyFields declares for it", () => {
    const g = must(addBlock(invisalign(), "welcome", faqBlock()));
    const long = "a".repeat(FLOW_LIMITS.faqQuestion + 40);
    const after = welcomeBlocksOf(must(setBlockText(g, "welcome", 0, "items[0].q", long)))[0]!;
    expect(after.kind === "faq" ? after.items[0]!.q.length : 0).toBe(FLOW_LIMITS.faqQuestion);
    expect(validateFlow(must(setBlockText(g, "welcome", 0, "items[0].q", long))).ok).toBe(true);
  });

  // MUTATION: normalise a cleared field to absent, the way the optional copy
  // setters do, and normaliseFlow refuses the whole graph on save - the funnel
  // comes back unreadable over one emptied box.
  it("refuses to empty a line, and says to remove the block instead", () => {
    const g = must(addBlock(invisalign(), "welcome", faqBlock()));
    expect(refusal(setBlockText(g, "welcome", 0, "items[0].q", "   "))).toContain("Remove the block");
  });

  it("refuses a field the block does not carry, including the picture reference", () => {
    let g = must(addBlock(invisalign(), "welcome", starterBlock("image")!));
    expect(refusal(setBlockText(g, "welcome", 0, "image", "screens/aligners"))).toContain("not something");
    expect(refusal(setBlockText(g, "welcome", 0, "quote", "hello"))).toContain("not something");
    g = must(addBlock(g, "welcome", faqBlock()));
    expect(refusal(setBlockText(g, "welcome", 1, "items[9].q", "hello"))).toContain("not something");
    expect(refusal(setBlockText(g, "welcome", 7, "quote", "hello"))).toContain("no longer on this screen");
  });

  // THE TWO LISTS AGREE. blockCopyFields is what rule 12 caps and what the
  // compliance scan reads; withBlockField is what the rail writes through. A field
  // in one and not the other is either an uneditable line or an unscanned one.
  it("can write every line blockCopyFields names, for every kind", () => {
    const samples: FlowBlock[] = [
      { kind: "trust-strip", practiceName: "Vitality Dental", chips: ["One", "Two"] },
      { kind: "testimonial", quote: "They explained every step.", attribution: "Jo B." },
      { kind: "faq", items: [{ q: "Q1", a: "A1" }, { q: "Q2", a: "A2" }] },
      { kind: "image", image: assessImagesForSlot("hero")[0]!.key, alt: "A picture" },
    ];
    for (const block of samples) {
      const g = must(addBlock(invisalign(), "welcome", block));
      for (const field of blockCopyFields(block)) {
        const after = must(setBlockText(g, "welcome", 0, field.field, "Rewritten"));
        const written = blockCopyFields(welcomeBlocksOf(after)[0]!).find((f) => f.field === field.field);
        expect(written?.text, `${block.kind}.${field.field} is not writable`).toBe("Rewritten");
      }
    }
  });
});

describe("a picture block's picture", () => {
  // MUTATION: carry the authored alt across a swap and a screen reader describes
  // the picture that used to be there.
  it("takes its description with it, because an alt describes the file", () => {
    const [first, second] = assessImagesForSlot("hero");
    const g = must(addBlock(invisalign(), "welcome", starterBlock("image")!));
    const owned = must(setBlockText(g, "welcome", 0, "alt", "Our reception"));
    expect(welcomeBlocksOf(owned)[0]).toEqual({ kind: "image", image: first!.key, alt: "Our reception" });

    const swapped = must(setBlockImage(owned, "welcome", 0, second!.key));
    expect(welcomeBlocksOf(swapped)[0]).toEqual({ kind: "image", image: second!.key, alt: second!.alt });
    expect(validateFlow(swapped).ok).toBe(true);
  });

  it("refuses an answer tile on a screen, a key that is not in the library, and a block with no picture", () => {
    const g = must(addBlock(invisalign(), "welcome", starterBlock("image")!));
    expect(refusal(setBlockImage(g, "welcome", 0, assessImagesForSlot("answer")[0]!.key))).toContain(
      "answer tile",
    );
    expect(refusal(setBlockImage(g, "welcome", 0, "https://example.com/x.jpg"))).toContain("never a link");
    const withFaq = must(addBlock(g, "welcome", faqBlock()));
    expect(refusal(setBlockImage(withFaq, "welcome", 1, "screens/aligners"))).toContain("no picture");
  });
});

describe("a block's own lists", () => {
  it("adds a chip in the owner's words and refuses a blank one", () => {
    const g = must(addBlock(invisalign(), "welcome", starterBlock("trust-strip", "Vitality Dental")!));
    expect(refusal(addBlockChip(g, "welcome", 0, "  "))).toContain("blank");
    const after = welcomeBlocksOf(must(addBlockChip(g, "welcome", 0, " Open Saturdays ")))[0]!;
    expect(after.kind === "trust-strip" ? after.chips : []).toEqual([
      "Takes about 30 seconds",
      "Open Saturdays",
    ]);
  });

  it("holds the chip cap and the faq cap", () => {
    let g = must(addBlock(invisalign(), "welcome", starterBlock("trust-strip", "Vitality Dental")!));
    while (welcomeBlocksOf(g)[0]!.kind === "trust-strip") {
      const chips = (welcomeBlocksOf(g)[0] as { chips: string[] }).chips;
      if (chips.length >= FLOW_LIMITS.chips) break;
      g = must(addBlockChip(g, "welcome", 0, `Chip ${chips.length}`));
    }
    expect(refusal(addBlockChip(g, "welcome", 0, "One too many"))).toContain(`${FLOW_LIMITS.chips}`);

    let f = must(addBlock(invisalign(), "welcome", faqBlock()));
    while ((welcomeBlocksOf(f)[0] as { items: unknown[] }).items.length < FLOW_LIMITS.faqItems) {
      const n = (welcomeBlocksOf(f)[0] as { items: unknown[] }).items.length;
      f = must(addBlockFaqItem(f, "welcome", 0, `Q${n}`, `A${n}`));
    }
    expect(refusal(addBlockFaqItem(f, "welcome", 0, "Q", "A"))).toContain(`${FLOW_LIMITS.faqItems}`);
    expect(refusal(addBlockFaqItem(f, "welcome", 0, "Q", ""))).toContain("needs an answer");
  });

  // MIN_CHIPS AND MIN_FAQ_ITEMS ARE RULE 12'S, PINNED AGAINST IT. flow-validate
  // holds the floors as literals (`< 1`, `< 2`); these ops hold their own copy, so
  // the copy is checked against the validator rather than trusted.
  it("will not take a list below the floor rule 12 publishes at", () => {
    const strip = must(addBlock(invisalign(), "welcome", starterBlock("trust-strip", "Vitality Dental")!));
    expect(refusal(removeBlockItem(strip, "welcome", 0, 0))).toContain("at least one chip");
    // ...and the floor is real: a trust strip with no chips does not validate.
    expect(
      validateFlow({
        ...strip,
        nodes: strip.nodes.map((n) =>
          n.id === "welcome" ? { ...n, blocks: [{ kind: "trust-strip", practiceName: "V", chips: [] }] } : n,
        ),
      } as FlowGraph).failures.some((f) => f.code === "trust_strip_chip_count"),
    ).toBe(true);

    const faq = must(addBlock(invisalign(), "welcome", faqBlock()));
    expect(refusal(removeBlockItem(faq, "welcome", 0, 0))).toContain("at least 2 questions");
    expect(
      validateFlow({
        ...faq,
        nodes: faq.nodes.map((n) =>
          n.id === "welcome" ? { ...n, blocks: [{ kind: "faq", items: [{ q: "Q", a: "A" }] }] } : n,
        ),
      } as FlowGraph).failures.some((f) => f.code === "faq_item_count"),
    ).toBe(true);
  });

  it("removes a chip once there is one to spare, and refuses a list a block has not got", () => {
    let g = must(addBlock(invisalign(), "welcome", starterBlock("trust-strip", "Vitality Dental")!));
    g = must(addBlockChip(g, "welcome", 0, "Open Saturdays"));
    const after = welcomeBlocksOf(must(removeBlockItem(g, "welcome", 0, 0)))[0]!;
    expect(after.kind === "trust-strip" ? after.chips : []).toEqual(["Open Saturdays"]);
    expect(refusal(removeBlockItem(g, "welcome", 0, 9))).toContain("no longer there");

    const image = must(addBlock(invisalign(), "welcome", starterBlock("image")!));
    expect(refusal(removeBlockItem(image, "welcome", 0, 0))).toContain("no list");
  });
});

describe("ordering and removing blocks", () => {
  // Authored order IS render order (flow-block-view.ts), so this is the control
  // that decides whether the trust strip sits above the questions or below them.
  it("moves a block up and down, and says which end it is already at", () => {
    let g = must(addBlock(invisalign(), "welcome", faqBlock()));
    g = must(addBlock(g, "welcome", starterBlock("image")!));
    expect(welcomeBlocksOf(g).map((b) => b.kind)).toEqual(["faq", "image"]);

    const moved = must(moveBlock(g, "welcome", 1, -1));
    expect(welcomeBlocksOf(moved).map((b) => b.kind)).toEqual(["image", "faq"]);
    expect(refusal(moveBlock(g, "welcome", 0, -1))).toContain("top");
    expect(refusal(moveBlock(g, "welcome", 1, 1))).toContain("bottom");
    expect(must(moveBlock(g, "welcome", 0, 0))).toEqual(g);
  });

  // MUTATION: leave `blocks: []` behind and the node is a v2 node carrying an
  // empty list. normaliseFlow tolerates it (flow.ts:486-491) but the graph then
  // claims content it does not have, which is exactly what misplaced() guards.
  it("takes the key away with the last block rather than leaving an empty list", () => {
    const g = must(addBlock(invisalign(), "welcome", faqBlock()));
    const bare = must(removeBlock(g, "welcome", 0));
    const node = bare.nodes.find((n) => n.id === "welcome")!;
    expect("blocks" in node ? node.blocks : undefined).toBeUndefined();
    expect(refusal(removeBlock(bare, "welcome", 0))).toContain("no longer on this screen");
  });
});

describe("every block op leaves a funnel the server can still read", () => {
  // THE INVARIANT. normaliseFlow is all-or-nothing: anything it cannot read comes
  // back as rule 0, "the funnel could not be read as a graph", which names nothing
  // the owner can fix. So no op here may be able to produce one.
  it("holds through a full editing session", () => {
    let g: FlowGraph = { ...invisalign(), schemaVersion: 1 };
    const readable = (): void => {
      expect(normaliseFlow(JSON.parse(JSON.stringify(g))), "unreadable graph").not.toBeNull();
    };
    readable();
    g = must(addBlock(g, "welcome", starterBlock("trust-strip", "Vitality Dental")!));
    readable();
    g = must(addBlockChip(g, "welcome", 0, "Open Saturdays"));
    readable();
    g = must(addBlock(g, "result-high", faqBlock()));
    readable();
    g = must(setBlockText(g, "result-high", 0, "items[0].a", "About half a minute."));
    readable();
    g = must(addBlock(g, "result-high", starterBlock("image")!));
    readable();
    g = must(moveBlock(g, "result-high", 1, -1));
    readable();
    g = must(removeBlock(g, "welcome", 0));
    readable();
    expect(validateFlow(g).ok).toBe(true);
  });

  it("never edits the graph it was handed", () => {
    const g = must(addBlock(invisalign(), "welcome", faqBlock()));
    untouched(g, (x) => addBlock(x, "result-low", starterBlock("image")!));
    untouched(g, (x) => setBlockText(x, "welcome", 0, "items[0].q", "New"));
    untouched(g, (x) => addBlockFaqItem(x, "welcome", 0, "Q", "A"));
    untouched(g, (x) => removeBlockItem(x, "welcome", 0, 0));
    untouched(g, (x) => moveBlock(x, "welcome", 0, 1));
    untouched(g, (x) => removeBlock(x, "welcome", 0));
    untouched(g, (x) => setOptionImage(x, "q-smile_concern", "crowded", "conditions/crowded"));
  });
});

/* ---------------------------------------------------------------------------
 * ANSWER-CARD PICTURES (rule 14's editing half).
 * ------------------------------------------------------------------------- */

const imagesOn = (g: FlowGraph, id: string): { value: string; image: string }[] => {
  const n = g.nodes.find((x) => x.id === id);
  return n && n.kind === "question" ? (n.optionImages ?? []) : [];
};

describe("pictures on the answer cards", () => {
  it("draws a row for every answer, in the order the patient sees them", () => {
    const g = invisalign();
    const rows = optionImageRows(g, "q-smile_concern");
    expect(rows.map((r) => r.value)).toEqual(
      routableAnswers(g.nodes.find((n) => n.id === "q-smile_concern")!).map((a) => a.value),
    );
    expect(rows.every((r) => r.image === null)).toBe(true);
    // Only the LAST answer may be left without one - rule 14's one relaxation,
    // and the escape hatch every bank question writes last.
    expect(rows.filter((r) => r.mayGoWithout).map((r) => r.value)).toEqual(["unsure"]);
    expect(optionImageRows(g, "welcome")).toEqual([]);
  });

  it("assigns a picture, replaces one in place, and bumps a pre-A2 funnel", () => {
    const v1: FlowGraph = { ...invisalign(), schemaVersion: 1 };
    let g = must(setOptionImage(v1, "q-smile_concern", "crowded", "conditions/crowded"));
    expect(g.schemaVersion).toBe(2);
    expect(imagesOn(g, "q-smile_concern")).toEqual([{ value: "crowded", image: "conditions/crowded" }]);

    g = must(setOptionImage(g, "q-smile_concern", "gaps", "conditions/gaps"));
    g = must(setOptionImage(g, "q-smile_concern", "crowded", "conditions/even-bite"));
    // Replaced where it stood: the order is what rule 14 walks and what the rail lists.
    expect(imagesOn(g, "q-smile_concern")).toEqual([
      { value: "crowded", image: "conditions/even-bite" },
      { value: "gaps", image: "conditions/gaps" },
    ]);
    expect(optionImageRows(g, "q-smile_concern")[0]!.image).toBe("conditions/even-bite");
  });

  it("refuses a screen picture, an unknown key, and an answer the question has not got", () => {
    const g = invisalign();
    expect(refusal(setOptionImage(g, "q-smile_concern", "crowded", "screens/aligners"))).toContain(
      "screen picture",
    );
    expect(refusal(setOptionImage(g, "q-smile_concern", "crowded", "../../etc/passwd"))).toContain(
      "never a link",
    );
    expect(refusal(setOptionImage(g, "q-smile_concern", "sedation", "conditions/crowded"))).toContain(
      "not an answer",
    );
    expect(refusal(setOptionImage(g, "welcome", "crowded", "conditions/crowded"))).toContain(
      "no longer there",
    );
  });

  // THE RAGGED RULE IS SURFACED, NOT ENFORCED HERE. Pictures go on one answer at a
  // time, so every grid is ragged on the way to being complete; an op that refused
  // the first picture would refuse all of them. MUTATION: refuse a ragged
  // assignment here and answer pictures become unusable.
  it("lets a grid be half-finished, and rule 14 is what says what is left", () => {
    const half = must(setOptionImage(invisalign(), "q-smile_concern", "crowded", "conditions/crowded"));
    const ragged = validateFlow(half).failures.find((f) => f.code === "option_images_ragged");
    expect(ragged?.message).toContain("gaps");
    expect(ragged?.message).toContain("unsure");

    // ...and a grid with every answer but the last one pictured is publishable.
    const pairs: [string, string][] = [
      ["crowded", "conditions/crowded"],
      ["gaps", "conditions/gaps"],
      ["open_bite", "conditions/open-bite"],
      ["overbite", "conditions/overbite"],
      ["underbite", "conditions/underbite"],
      ["crossbite", "conditions/crossbite"],
      ["even", "conditions/even-bite"],
    ];
    let g = invisalign();
    for (const [value, key] of pairs) g = must(setOptionImage(g, "q-smile_concern", value, key));
    expect(validateFlow(g).ok).toBe(true);
    expect(optionImageRows(g, "q-smile_concern").filter((r) => r.image === null).map((r) => r.value)).toEqual([
      "unsure",
    ]);
  });

  it("removes a picture and takes the key away with the last one", () => {
    let g = must(setOptionImage(invisalign(), "q-smile_concern", "crowded", "conditions/crowded"));
    g = must(setOptionImage(g, "q-smile_concern", "gaps", "conditions/gaps"));
    g = must(removeOptionImage(g, "q-smile_concern", "crowded"));
    expect(imagesOn(g, "q-smile_concern")).toEqual([{ value: "gaps", image: "conditions/gaps" }]);

    const bare = must(removeOptionImage(g, "q-smile_concern", "gaps"));
    const node = bare.nodes.find((n) => n.id === "q-smile_concern")!;
    expect("optionImages" in node ? node.optionImages : undefined).toBeUndefined();
    expect(refusal(removeOptionImage(bare, "q-smile_concern", "gaps"))).toContain("no picture");
  });

  it("keeps the step's lead-in line when a picture changes", () => {
    let g = must(setQuestionTransition(invisalign(), "q-smile_concern", "Nearly there."));
    g = must(setOptionImage(g, "q-smile_concern", "crowded", "conditions/crowded"));
    const node = g.nodes.find((n) => n.id === "q-smile_concern")!;
    expect(node.kind === "question" ? node.transition : null).toBe("Nearly there.");
  });
});

describe("what changing a question costs", () => {
  // setNodeQuestion DROPS answer pictures - it has to, they name the old
  // question's options (rule 14 would fail on every one). The rail has no confirm
  // dialog anywhere, so the cost is said in words, on the picker, first.
  // MUTATION: return null here and the swap silently deletes the owner's pictures.
  it("says how many pictures a swap would take with it, before it is made", () => {
    const g = invisalign();
    expect(questionSwapWarning(g, "q-smile_concern")).toBeNull();
    expect(questionSwapWarning(g, "welcome")).toBeNull();

    const one = must(setOptionImage(g, "q-smile_concern", "crowded", "conditions/crowded"));
    expect(questionSwapWarning(one, "q-smile_concern")).toContain("the answer picture");
    const two = must(setOptionImage(one, "q-smile_concern", "gaps", "conditions/gaps"));
    expect(questionSwapWarning(two, "q-smile_concern")).toContain("the 2 answer pictures");

    // ...and the warning is honest: the swap really does drop them.
    const swapped = must(setNodeQuestion(two, "q-smile_concern", "align_detail"));
    expect(imagesOn(swapped, "q-smile_concern")).toEqual([]);
    expect(validateFlow(swapped).ok).toBe(true);
  });
});
