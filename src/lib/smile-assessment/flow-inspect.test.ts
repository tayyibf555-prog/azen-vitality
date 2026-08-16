// THE INSPECTOR'S OWN RULES: what a control in the rail MEANS, and where a
// validation failure belongs in it.
//
// WHY THIS SUITE EXISTS SEPARATELY FROM flow-edit.test.ts. That one holds what an
// op does to a graph. This one holds the layer above: which op a box in the rail
// is, what it re-sends alongside what the owner typed, and what happens when the
// selection has gone stale underneath it. Every one of those was written in JSX
// before A1, where vitest could not reach it - and two of them (the welcome
// pairing rule, and a "Route it" button that was disabled instead of explaining
// itself) were already wrong there.

import { describe, it, expect } from "vitest";
import { type FlowBlock, type FlowGraph, type FlowNode } from "./flow";
import { validateFlow, type FlowValidationFailure } from "./flow-validate";
import { templateForGoal } from "./flow-templates";
import { setEdgeAnswer, starterBlock } from "./flow-edit";
import {
  applyInspectorEdit,
  blockIssues,
  blockIssuesFor,
  edgeIssues,
  edgeWhere,
  isNodeSelected,
  issuesFor,
  nodeIssues,
  selectionAfterEdit,
  stepAfter,
  type FlowSelection,
  type InspectorEdit,
} from "./flow-inspect";
import { Q_TIMELINE } from "./quiz";

const invisalign = (): FlowGraph => templateForGoal("invisalign").build();

const at = (id: string): FlowSelection => ({ kind: "node", id });

function must(result: ReturnType<typeof applyInspectorEdit>): FlowGraph {
  if (!result.ok) throw new Error(`expected an edit, got: ${result.reason}`);
  return result.graph;
}

function refused(result: ReturnType<typeof applyInspectorEdit>): string {
  if (result.ok) throw new Error("expected a refusal, got an edited graph");
  return result.reason;
}

function nodeOf(graph: FlowGraph, id: string): FlowNode {
  const found = graph.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

/** An edit run against a copy, so "the input was not touched" is checkable. */
function unchanged(graph: FlowGraph, edit: InspectorEdit, selection: FlowSelection): void {
  const before = JSON.stringify(graph);
  applyInspectorEdit(graph, selection, edit);
  expect(JSON.stringify(graph), "the draft graph was mutated in place").toBe(before);
}

/* ---------------------------------------------------------------------------
 * 1. THE ROUND TRIP: a control's intent, onto the graph.
 * ------------------------------------------------------------------------- */

describe("a control's intent becomes an edit on the draft graph", () => {
  // MUTATION: have the picker rebuild the node instead of going through
  // setNodeQuestion, and the step keeps its lead-in but loses its place in the
  // wiring - or keeps answer-card pictures that name the OLD question's options.
  it("the question picker changes what that one screen asks, and nothing else", () => {
    const before = invisalign();
    const after = must(
      applyInspectorEdit(before, at("q-smile_concern"), {
        kind: "question",
        questionId: "align_detail",
      }),
    );

    const node = nodeOf(after, "q-smile_concern");
    expect(node.kind).toBe("question");
    expect(node.kind === "question" ? node.questionId : null).toBe("align_detail");
    // Every wire is where it was: the screen kept its place in the funnel.
    expect(after.edges).toEqual(before.edges);
    expect(after.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
    // ...and the funnel is still one that can go live.
    expect(validateFlow(after).ok).toBe(true);
  });

  it("hands back a NEW graph and never touches the one it was given", () => {
    const g = invisalign();
    unchanged(g, { kind: "question", questionId: "align_detail" }, at("q-smile_concern"));
    unchanged(g, { kind: "transition", text: "Nearly there." }, at("q-timeline"));
    unchanged(g, { kind: "remove-node" }, at("q-readiness"));
    unchanged(g, { kind: "edge-target", index: 0, to: "contact" }, at("welcome"));
  });

  // MUTATION: the one this module was built for. `setWelcomeCopy` takes BOTH
  // fields, so a box that sends only its own clears the other. Typing an intro
  // and watching the headline disappear - with the save reporting success - is
  // the failure this pins shut, in both directions.
  it("the welcome boxes re-send each other, so neither clears the other", () => {
    const base = invisalign();
    const withCopy = must(
      applyInspectorEdit(base, at("welcome"), { kind: "headline", text: "Is Invisalign for you?" }),
    );
    const both = must(
      applyInspectorEdit(withCopy, at("welcome"), { kind: "intro", text: "Two minutes." }),
    );

    const node = nodeOf(both, "welcome");
    expect(node.kind === "welcome" ? node.headline : null).toBe("Is Invisalign for you?");
    expect(node.kind === "welcome" ? node.intro : null).toBe("Two minutes.");

    // ...and the other way round: re-typing the headline keeps the intro.
    const reheaded = must(
      applyInspectorEdit(both, at("welcome"), { kind: "headline", text: "Straighter teeth?" }),
    );
    const after = nodeOf(reheaded, "welcome");
    expect(after.kind === "welcome" ? after.headline : null).toBe("Straighter teeth?");
    expect(after.kind === "welcome" ? after.intro : null).toBe("Two minutes.");
  });

  // MUTATION: one "headline" op for both screens. A result screen has no intro
  // and a welcome screen's headline is half of a pair - one op cannot be both.
  it("the headline box is the welcome op on a welcome step and the result op on a result", () => {
    const g = invisalign();
    const result = must(
      applyInspectorEdit(g, at("result-high"), { kind: "headline", text: "You are a good fit" }),
    );
    const node = nodeOf(result, "result-high");
    expect(node.kind === "outcome" ? node.headline : null).toBe("You are a good fit");
    // A result screen has no opening line, and says so rather than writing one.
    expect(refused(applyInspectorEdit(g, at("result-high"), { kind: "intro", text: "hello" }))).toContain(
      "opening screen",
    );
  });

  // MUTATION: keep the old builder's behaviour - a disabled button - and the
  // owner clicks a control that does nothing and is told nothing.
  it("routing an answer with nowhere to send it refuses IN WORDS", () => {
    const stranded: FlowGraph = {
      schemaVersion: 1,
      entry: "q",
      nodes: [{ id: "q", kind: "question", questionId: Q_TIMELINE }],
      edges: [],
    };
    const reason = refused(
      applyInspectorEdit(stranded, at("q"), { kind: "route-option", value: "asap" }),
    );
    expect(reason).toContain("Connect it first");
  });

  it("routing an answer sends it the same way as the rest", () => {
    const g = invisalign();
    // Give the timeline step a specific route, which leaves its other options
    // running on the default - then route one of them explicitly.
    const after = must(applyInspectorEdit(g, at("q-timeline"), { kind: "route-option", value: "asap" }));
    const added = after.edges.find((e) => e.from === "q-timeline" && e.answer === "asap");
    expect(added?.to).toBe("q-budget_readiness");
    expect(validateFlow(after).ok).toBe(true);
  });

  // MUTATION: let the branch rows fall through to "nothing is selected". The
  // rows on a STEP's rail edit that step's own wires, so an edge edit has to be
  // valid from a node selection.
  it("a branch row edits its wire from the step's own rail", () => {
    const g = invisalign();
    const index = g.edges.findIndex((e) => e.from === "q-timeline");
    const after = must(
      applyInspectorEdit(g, at("q-timeline"), { kind: "edge-target", index, to: "contact" }),
    );
    expect(after.edges[index]?.to).toBe("contact");
  });

  /**
   * THE FLOOR UNDER A DEAD END. "Route this answer" sends it the same way as the
   * rest, and on a step with NO route out there is no rest - which is how a funnel
   * used to become unpublishable and unrepairable from one Trash button. The
   * connect control is the repair, and it is node-scoped like the copy fields.
   */
  it("connects a step that leads nowhere, from that step's own rail", () => {
    const g = invisalign();
    const only = g.edges.findIndex((e) => e.from === "welcome");
    const stranded = must(applyInspectorEdit(g, at("welcome"), { kind: "remove-edge", index: only }));
    expect(stranded.edges.some((e) => e.from === "welcome")).toBe(false);
    expect(
      refused(applyInspectorEdit(stranded, at("welcome"), { kind: "route-option", value: "asap" })),
    ).toContain("Connect it first");

    const joined = must(
      applyInspectorEdit(stranded, at("welcome"), {
        kind: "connect",
        to: "q-treatment_interest",
        answer: null,
      }),
    );
    expect(validateFlow(joined).ok).toBe(true);
    // ...and it refuses what addEdge refuses, rather than making a second wire the
    // runtime would never take.
    expect(
      refused(
        applyInspectorEdit(joined, at("welcome"), {
          kind: "connect",
          to: "contact",
          answer: null,
        }),
      ),
    ).toContain("anything else");
    expect(
      refused(applyInspectorEdit(joined, at("welcome"), { kind: "connect", to: "welcome", answer: null })),
    ).toContain("itself");
  });

  // MUTATION: address the + at the SELECTION instead of at the screen it sits
  // beside, and clicking a + without selecting first adds the screen somewhere
  // else entirely - or refuses, from a control that is plainly next to a screen.
  it("adds a screen after the step the + names, whatever is selected", () => {
    const g = invisalign();
    const after = must(
      applyInspectorEdit(g, null, { kind: "add-screen", nodeId: "q-timeline", questionId: "motivation" }),
    );
    expect(after.nodes.some((n) => n.id === "q-motivation")).toBe(true);
    // Spliced onto the wire the step actually falls back to.
    expect(after.edges.some((e) => e.from === "q-timeline" && e.to === "q-motivation")).toBe(true);
    expect(after.edges.some((e) => e.from === "q-motivation" && e.to === "q-budget_readiness")).toBe(
      true,
    );
    expect(validateFlow(after).ok).toBe(true);

    // The validator's list is the picker's rule even when there is no picker.
    expect(
      refused(
        applyInspectorEdit(g, null, {
          kind: "add-screen",
          nodeId: "q-timeline",
          questionId: Q_TIMELINE,
        }),
      ),
    ).toContain("already asked");
    expect(
      refused(applyInspectorEdit(g, null, { kind: "add-screen", nodeId: "result-high" })),
    ).toContain("Connect it first");
  });

  it("moves a branch among its siblings from the step's rail", () => {
    const g = invisalign();
    const first = g.edges.findIndex((e) => e.from === "q-treatment_interest");
    const after = must(applyInspectorEdit(g, at("q-treatment_interest"), {
      kind: "move-edge",
      index: first,
      delta: 1,
    }));
    expect(after.edges[first]?.answer).toBeNull();
    expect(
      refused(
        applyInspectorEdit(g, at("q-treatment_interest"), {
          kind: "move-edge",
          index: first,
          delta: -1,
        }),
      ),
    ).toContain("first");
  });
});

/* ---------------------------------------------------------------------------
 * 2. A STALE SELECTION. The rail is driven by state that the graph can move
 *    underneath - a step removed, a connection deleted, the selection cleared.
 * ------------------------------------------------------------------------- */

describe("an edit against a selection that has gone", () => {
  // MUTATION: throw (a blank builder), or return the graph unchanged (a control
  // that silently does nothing - the failure this whole layer is written against).
  it("refuses in words rather than throwing or quietly doing nothing", () => {
    const g = invisalign();
    expect(refused(applyInspectorEdit(g, null, { kind: "transition", text: "x" }))).toContain(
      "Nothing is selected",
    );
    expect(
      refused(applyInspectorEdit(g, { kind: "edge", index: 0 }, { kind: "remove-node" })),
    ).toContain("Nothing is selected");
    expect(refused(applyInspectorEdit(g, at("gone"), { kind: "transition", text: "x" }))).toContain(
      "no longer there",
    );
  });

  it("refuses an edge edit whose wire has been removed", () => {
    const g = invisalign();
    expect(
      refused(applyInspectorEdit(g, at("q-timeline"), { kind: "edge-target", index: 99, to: "contact" })),
    ).toContain("no longer there");
  });
});

/* ---------------------------------------------------------------------------
 * 3. Selection helpers.
 * ------------------------------------------------------------------------- */

describe("moving the selection with the arrow keys", () => {
  const ids = ["a", "b", "c"];

  // MUTATION: wrap instead of clamping and the right arrow on the last result
  // screen jumps to the opening screen, which reads as the selection being lost.
  it("clamps at both ends rather than wrapping", () => {
    expect(stepAfter(ids, "a", 1)).toBe("b");
    expect(stepAfter(ids, "c", 1)).toBe("c");
    expect(stepAfter(ids, "a", -1)).toBe("a");
    expect(stepAfter(ids, "b", -1)).toBe("a");
  });

  it("starts at the end the arrow came from when nothing is selected", () => {
    expect(stepAfter(ids, null, 1)).toBe("a");
    expect(stepAfter(ids, null, -1)).toBe("c");
    // A step that has since been removed is the same situation.
    expect(stepAfter(ids, "gone", 1)).toBe("a");
    expect(stepAfter([], null, 1)).toBeNull();
  });

  // MUTATION: keep the selection through a removal and the rail is pointed at a
  // step that no longer exists - or, worse, an edge INDEX that now means the
  // connection after the one that was deleted, so the next edit silently
  // re-points a wire the owner never looked at.
  it("drops the selection only for the edits that move the ground under it", () => {
    const g = invisalign();
    const node: FlowSelection = { kind: "node", id: "q-timeline" };
    const edge: FlowSelection = { kind: "edge", index: 3 };
    for (const edit of [
      { kind: "remove-node" },
      { kind: "remove-edge", index: 3 },
    ] as InspectorEdit[]) {
      expect(selectionAfterEdit(node, edit, g), edit.kind).toBeNull();
      expect(selectionAfterEdit(edge, edit, g), edit.kind).toBeNull();
    }
    // A reorder swaps two edge INDICES, so a connection's selection now addresses
    // its neighbour - but the step the branch rows fired it from is untouched.
    const move: InspectorEdit = { kind: "move-edge", index: 3, delta: 1 };
    expect(selectionAfterEdit(edge, move, g)).toBeNull();
    expect(selectionAfterEdit(node, move, g)).toBe(node);

    for (const edit of [
      { kind: "question", questionId: "motivation" },
      { kind: "transition", text: "x" },
      { kind: "headline", text: "x" },
      { kind: "intro", text: "x" },
      { kind: "route-option", value: "asap" },
      { kind: "connect", to: "contact", answer: null },
      { kind: "edge-target", index: 3, to: "contact" },
      { kind: "edge-answer", index: 3, answer: null },
      { kind: "edge-transition", index: 3, text: "x" },
    ] as InspectorEdit[]) {
      expect(selectionAfterEdit(node, edit, g), edit.kind).toBe(node);
      expect(selectionAfterEdit(edge, edit, g), edit.kind).toBe(edge);
    }
  });

  /**
   * ADDING A SCREEN LANDS ON THE SCREEN, which is the difference between a + that
   * works and a + that appears to do nothing on a strip too tall to see all of.
   *
   * MUTATION: return null here (what removal does) and the one-click + drops a
   * question of its own choosing into the funnel, closes the rail, and leaves the
   * owner to find it among nine screens - with no way to see WHICH question it
   * picked short of reading every one.
   */
  it("lands on the screen an insertion just made, named the way the op will name it", () => {
    const g = invisalign();
    const edge: FlowSelection = { kind: "edge", index: 3 };

    const added: InspectorEdit = { kind: "add-screen", nodeId: "q-timeline" };
    const landed = selectionAfterEdit(edge, added, g);
    expect(landed?.kind).toBe("node");

    // The name is not asserted as a literal: it is checked against the graph the
    // edit actually produces, which is the only claim worth holding.
    const next = must(applyInspectorEdit(g, edge, added));
    expect(landed && landed.kind === "node" && next.nodes.some((n) => n.id === landed.id)).toBe(
      true,
    );
    expect(g.nodes.some((n) => landed?.kind === "node" && n.id === landed.id)).toBe(false);

    const spliced: InspectorEdit = { kind: "insert-question", index: 3, questionId: "motivation" };
    const onNew = selectionAfterEdit(edge, spliced, g);
    expect(onNew).toEqual({ kind: "node", id: "q-motivation" });
    expect(must(applyInspectorEdit(g, edge, spliced)).nodes.some((n) => n.id === "q-motivation")).toBe(
      true,
    );
  });

  it("knows which step is selected, and only that one", () => {
    expect(isNodeSelected({ kind: "node", id: "a" }, "a")).toBe(true);
    expect(isNodeSelected({ kind: "node", id: "a" }, "b")).toBe(false);
    expect(isNodeSelected({ kind: "edge", index: 0 }, "a")).toBe(false);
    expect(isNodeSelected(null, "a")).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * 4. WHERE A FAILURE BELONGS, against what validateFlow really says.
 *
 * Every fixture below is broken on purpose and run through the REAL validator,
 * never through a hand-written failure. That is what makes this suite catch the
 * one drift a mapping like this cannot survive: flow-validate.ts changing how it
 * writes an edge's `where`.
 * ------------------------------------------------------------------------- */

function failuresOf(graph: FlowGraph): FlowValidationFailure[] {
  const result = validateFlow(graph);
  expect(result.failures.length, "the fixture is not broken").toBeGreaterThan(0);
  return result.failures;
}

describe("a validation failure is shown against the control that fixes it", () => {
  // MUTATION: map an unknown question to the copy field and the owner is told to
  // rewrite a lead-in line to fix a step that has no question at all.
  it("puts a question failure on the question picker", () => {
    const g = invisalign();
    const broken: FlowGraph = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === "q-timeline" ? { id: n.id, kind: "question", questionId: "not_a_question" } : n,
      ),
    };
    const issues = nodeIssues(broken, failuresOf(broken), "q-timeline");
    const onPicker = issuesFor(issues, "question");
    expect(onPicker.map((i) => i.code)).toContain("unknown_question");
    expect(onPicker[0]?.message).toContain("question bank");
  });

  // MUTATION: leave the branch codes unmapped and the one failure a branch list
  // exists to fix - an answer that leads nowhere - lands at the head of the rail
  // instead, above a list that would have shown which answer it was.
  it("puts an uncovered answer on the branch list", () => {
    const g = invisalign();
    const index = g.edges.findIndex((e) => e.from === "q-timeline" && e.answer === null);
    const narrowed = setEdgeAnswer(g, index, "asap");
    if (!narrowed.ok) throw new Error(narrowed.reason);
    const issues = nodeIssues(narrowed.graph, failuresOf(narrowed.graph), "q-timeline");
    expect(issuesFor(issues, "branches").map((i) => i.code)).toContain("option_uncovered");
  });

  // MUTATION: parse the edge `where` instead of rebuilding it and a rename in
  // flow-validate.ts silently re-attributes messages to the wrong branch. This is
  // the round-trip that catches it: the label is built here, the failure is built
  // there, and they have to be the same string.
  it("carries an edge's own failure onto the step it leaves, and onto that connection", () => {
    const g = invisalign();
    // A second default route out of one step: rule 3, reported on the edge.
    const doubled: FlowGraph = {
      ...g,
      edges: [...g.edges, { from: "q-timeline", to: "contact", answer: null }],
    };
    const index = doubled.edges.length - 1;
    const failures = failuresOf(doubled);
    expect(failures.some((f) => f.where === edgeWhere(doubled.edges[index]!))).toBe(true);

    // On the step's rail: under the branch list, where both wires are shown.
    const onStep = nodeIssues(doubled, failures, "q-timeline");
    expect(issuesFor(onStep, "branches").map((i) => i.code)).toContain("duplicate_edge_answer");

    // On the connection's own rail: under its answer picker, which is the field
    // that is wrong.
    const onEdge = edgeIssues(doubled, failures, index);
    expect(issuesFor(onEdge, "answer").map((i) => i.code)).toContain("duplicate_edge_answer");
  });

  it("puts a loop on the connection's destination", () => {
    const g = invisalign();
    const looped: FlowGraph = {
      ...g,
      edges: [...g.edges, { from: "q-location", to: "q-timeline", answer: null }],
    };
    const index = looped.edges.length - 1;
    const onEdge = edgeIssues(looped, failuresOf(looped), index);
    expect(issuesFor(onEdge, "target").map((i) => i.code)).toContain("cycle");
  });

  // MUTATION: drop the fallback and a rule added to flow-validate.ts tomorrow is
  // reported by the banner and invisible in the rail - which is exactly where the
  // owner is standing when they read it.
  it("shows an unmapped failure at the head of the rail rather than swallowing it", () => {
    const g = invisalign();
    // An orphaned step: named on the node, with no control of its own.
    const orphaned: FlowGraph = {
      ...g,
      edges: g.edges.filter((e) => e.to !== "q-readiness"),
    };
    const issues = nodeIssues(orphaned, failuresOf(orphaned), "q-readiness");
    expect(issuesFor(issues, "step").map((i) => i.code)).toContain("orphan");
  });

  // MUTATION: filter by `where === nodeId` alone and a failure on this step's own
  // wire vanishes from its rail. Nothing that names a step (or one of its wires)
  // may be missing from that step's issues.
  it("loses nothing: every failure naming a step reaches that step's rail", () => {
    const g = invisalign();
    const broken: FlowGraph = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === "q-timeline" ? { id: n.id, kind: "question", questionId: "not_a_question" } : n,
      ),
      edges: [...g.edges, { from: "q-timeline", to: "contact", answer: null }],
    };
    const failures = failuresOf(broken);
    const own = new Set(
      broken.edges.filter((e) => e.from === "q-timeline").map((e) => edgeWhere(e)),
    );
    const mine = failures.filter((f) => f.where === "q-timeline" || own.has(f.where));
    expect(mine.length).toBeGreaterThan(1);
    const shown = nodeIssues(broken, failures, "q-timeline");
    expect(shown.length).toBe(mine.length);
    for (const f of mine) expect(shown.some((i) => i.code === f.code && i.message === f.message)).toBe(true);
  });

  it("says nothing about a step that is fine, or a connection that has gone", () => {
    const g = invisalign();
    expect(nodeIssues(g, validateFlow(g).failures, "q-timeline")).toEqual([]);
    expect(edgeIssues(g, validateFlow(g).failures, 99)).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * 5. THE BLOCK CONTROLS. A2's furniture, driven from the rail.
 *
 * The intents here carry WORDS rather than finished blocks, because the one rule
 * this lane turns on is what a new block is allowed to say. A rail that assembled
 * the block itself would put that rule in JSX, where the charter's "AI never
 * invents a testimonial" becomes a disabled attribute on a button.
 * ------------------------------------------------------------------------- */

const blocksOn = (graph: FlowGraph, id: string): FlowBlock[] => {
  const n = nodeOf(graph, id);
  return n.kind === "welcome" || n.kind === "outcome" ? (n.blocks ?? []) : [];
};

describe("adding a content block from the rail", () => {
  // THE CHARTER RULE. MUTATION: let this through with a starter quote and the
  // funnel can be published carrying words no patient ever said.
  it("refuses a testimonial with no quote, and says whose words it has to be", () => {
    const g = invisalign();
    const reason = refused(
      applyInspectorEdit(g, at("welcome"), { kind: "add-block", blockKind: "testimonial" }),
    );
    expect(reason).toContain("the practice already holds");
    expect(reason).toContain("nothing here writes one for you");

    // Half of it is still none of it: an anonymous quote is an unattributed claim.
    expect(
      refused(
        applyInspectorEdit(g, at("welcome"), {
          kind: "add-block",
          blockKind: "testimonial",
          quote: "They explained every step.",
        }),
      ),
    ).toContain("nothing here writes one for you");
  });

  it("takes a testimonial the practice typed, verbatim", () => {
    const g = must(
      applyInspectorEdit(invisalign(), at("welcome"), {
        kind: "add-block",
        blockKind: "testimonial",
        quote: "  They explained every step before starting.  ",
        attribution: " Jo B. ",
      }),
    );
    expect(blocksOn(g, "welcome")).toEqual([
      { kind: "testimonial", quote: "They explained every step before starting.", attribution: "Jo B." },
    ]);
    expect(validateFlow(g).ok).toBe(true);
  });

  it("starts a trust strip only when it has been given a name to put on it", () => {
    const g = invisalign();
    expect(
      refused(applyInspectorEdit(g, at("welcome"), { kind: "add-block", blockKind: "trust-strip" })),
    ).toContain("practice’s name");

    const named = must(
      applyInspectorEdit(g, at("welcome"), {
        kind: "add-block",
        blockKind: "trust-strip",
        practiceName: "Vitality Dental",
      }),
    );
    expect(blocksOn(named, "welcome")[0]).toEqual(
      starterBlock("trust-strip", "Vitality Dental"),
    );
  });

  it("adds the kinds that need no words of their own straight away", () => {
    const faq = must(applyInspectorEdit(invisalign(), at("welcome"), { kind: "add-block", blockKind: "faq" }));
    expect(blocksOn(faq, "welcome")[0]).toEqual(starterBlock("faq"));
    const picture = must(applyInspectorEdit(faq, at("result-high"), { kind: "add-block", blockKind: "image" }));
    expect(blocksOn(picture, "result-high")[0]).toEqual(starterBlock("image"));
    expect(validateFlow(picture).ok).toBe(true);
  });

  it("refuses a kind this build cannot render, rather than guessing", () => {
    expect(
      refused(
        applyInspectorEdit(invisalign(), at("welcome"), {
          kind: "add-block",
          blockKind: "video" as never,
        }),
      ),
    ).toContain("not a content block");
  });

  // THE SELECTION RULE, which every node-scoped intent shares: a block edit fired
  // against a CONNECTION (or a step that has since gone) refuses in words rather
  // than editing whatever happens to be first.
  it("refuses when the rail is not pointed at a screen", () => {
    const g = invisalign();
    expect(refused(applyInspectorEdit(g, { kind: "edge", index: 0 }, { kind: "add-block", blockKind: "faq" }))).toContain(
      "Nothing is selected",
    );
    expect(refused(applyInspectorEdit(g, at("gone"), { kind: "remove-block", index: 0 }))).toContain(
      "no longer there",
    );
  });
});

describe("editing a block from the rail", () => {
  const withFaq = (): FlowGraph =>
    must(applyInspectorEdit(invisalign(), at("welcome"), { kind: "add-block", blockKind: "faq" }));

  it("routes each control to the op that holds its rule", () => {
    let g = withFaq();
    g = must(applyInspectorEdit(g, at("welcome"), { kind: "block-faq-add", index: 0, q: "Is it far?", a: "Ten minutes from the station." }));
    expect((blocksOn(g, "welcome")[0] as { items: unknown[] }).items).toHaveLength(3);

    g = must(applyInspectorEdit(g, at("welcome"), { kind: "block-text", index: 0, field: "items[2].a", text: "Five minutes from the station." }));
    expect(blocksOn(g, "welcome")[0]).toMatchObject({ items: [{}, {}, { a: "Five minutes from the station." }] });

    g = must(applyInspectorEdit(g, at("welcome"), { kind: "block-item-remove", index: 0, at: 0 }));
    expect((blocksOn(g, "welcome")[0] as { items: unknown[] }).items).toHaveLength(2);

    g = must(applyInspectorEdit(g, at("welcome"), { kind: "add-block", blockKind: "image" }));
    g = must(applyInspectorEdit(g, at("welcome"), { kind: "block-image", index: 1, image: "screens/fresh-smile" }));
    expect(blocksOn(g, "welcome")[1]).toMatchObject({ kind: "image", image: "screens/fresh-smile" });

    g = must(applyInspectorEdit(g, at("welcome"), { kind: "move-block", index: 1, delta: -1 }));
    expect(blocksOn(g, "welcome").map((b) => b.kind)).toEqual(["image", "faq"]);

    g = must(applyInspectorEdit(g, at("welcome"), { kind: "remove-block", index: 0 }));
    expect(blocksOn(g, "welcome").map((b) => b.kind)).toEqual(["faq"]);
    expect(validateFlow(g).ok).toBe(true);
  });

  it("carries a chip's words through and refuses a blank one", () => {
    const strip = must(
      applyInspectorEdit(invisalign(), at("welcome"), {
        kind: "add-block",
        blockKind: "trust-strip",
        practiceName: "Vitality Dental",
      }),
    );
    expect(refused(applyInspectorEdit(strip, at("welcome"), { kind: "block-chip-add", index: 0, text: " " }))).toContain(
      "blank",
    );
    const g = must(applyInspectorEdit(strip, at("welcome"), { kind: "block-chip-add", index: 0, text: "Open Saturdays" }));
    expect(blocksOn(g, "welcome")[0]).toMatchObject({ chips: ["Takes about 30 seconds", "Open Saturdays"] });
  });

  // A block edit does not move the ground under the selection - unlike an
  // insertion or a removal, which is what selectionAfterEdit exists for. Standing
  // still is the right answer: the owner is editing THIS screen.
  it("leaves the selection on the screen being edited", () => {
    const g = withFaq();
    const here = at("welcome");
    for (const edit of [
      { kind: "add-block", blockKind: "image" },
      { kind: "block-text", index: 0, field: "items[0].q", text: "Changed?" },
      { kind: "remove-block", index: 0 },
      { kind: "move-block", index: 0, delta: 1 },
      { kind: "option-image", value: "crowded", image: "conditions/crowded" },
    ] as InspectorEdit[]) {
      expect(selectionAfterEdit(here, edit, g)).toEqual(here);
    }
  });

  it("hands back a NEW graph and never touches the one it was given", () => {
    const g = withFaq();
    unchanged(g, { kind: "block-text", index: 0, field: "items[0].q", text: "New" }, at("welcome"));
    unchanged(g, { kind: "remove-block", index: 0 }, at("welcome"));
    unchanged(g, { kind: "option-image", value: "crowded", image: "conditions/crowded" }, at("q-smile_concern"));
  });
});

describe("answer-card pictures from the rail", () => {
  it("assigns and removes one, through the ops that check the manifest", () => {
    const g = must(
      applyInspectorEdit(invisalign(), at("q-smile_concern"), {
        kind: "option-image",
        value: "crowded",
        image: "conditions/crowded",
      }),
    );
    const node = nodeOf(g, "q-smile_concern");
    expect(node.kind === "question" ? node.optionImages : null).toEqual([
      { value: "crowded", image: "conditions/crowded" },
    ]);

    expect(
      refused(
        applyInspectorEdit(g, at("q-smile_concern"), {
          kind: "option-image",
          value: "crowded",
          image: "screens/aligners",
        }),
      ),
    ).toContain("screen picture");

    const bare = must(
      applyInspectorEdit(g, at("q-smile_concern"), { kind: "option-image-remove", value: "crowded" }),
    );
    const after = nodeOf(bare, "q-smile_concern");
    expect(after.kind === "question" ? after.optionImages : undefined).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * 6. WHERE A BLOCK FAILURE BELONGS IN THE RAIL.
 * ------------------------------------------------------------------------- */

/** A funnel whose welcome screen carries two genuinely broken blocks. */
function withBrokenBlocks(): FlowGraph {
  const g = invisalign();
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === "welcome"
        ? {
            ...n,
            blocks: [
              // rule 12: a faq needs 2 to 6 questions. Named on the BLOCK.
              { kind: "faq", items: [{ q: "Only one", a: "Answer" }] },
              // rule 13: named on the block's `image` LINE.
              { kind: "image", image: "screens/does-not-exist", alt: "A picture" },
            ],
          }
        : n,
    ),
  } as FlowGraph;
}

describe("a failure inside a block", () => {
  it("lands in the blocks section of the step it is on", () => {
    const g = withBrokenBlocks();
    const failures = validateFlow(g).failures;
    const codes = issuesFor(nodeIssues(g, failures, "welcome"), "blocks").map((i) => i.code);
    expect(codes).toContain("faq_item_count");
    expect(codes).toContain("image_unknown");
    // ...and nothing about a block is dumped at the head of the rail instead.
    expect(issuesFor(nodeIssues(g, failures, "welcome"), "step")).toEqual([]);
  });

  it("carries the LINE it is about, so the rail can print it under that box", () => {
    const failures = validateFlow(withBrokenBlocks()).failures;

    const faq = blockIssues(failures, "welcome", 0);
    expect(faq).toHaveLength(1);
    expect(faq[0]!.field).toBeNull(); // about the block, not about one line
    expect(faq[0]!.code).toBe("faq_item_count");

    const picture = blockIssues(failures, "welcome", 1);
    expect(picture.map((i) => i.field)).toEqual(["image"]);
    expect(blockIssuesFor(picture, "image")).toHaveLength(1);
    expect(blockIssuesFor(picture, null)).toEqual([]);
  });

  // MUTATION: match with startsWith(prefix) alone and block 1 shows block 10's
  // failures the first time a screen has eleven of them.
  it("does not confuse blocks[1] with blocks[10]", () => {
    const failures: FlowValidationFailure[] = [
      { rule: 12, code: "block_text_empty", where: `node "welcome".blocks[10].quote`, message: "ten" },
      { rule: 12, code: "faq_item_count", where: `node "welcome".blocks[1]`, message: "one" },
    ];
    expect(blockIssues(failures, "welcome", 1).map((i) => i.message)).toEqual(["one"]);
    expect(blockIssues(failures, "welcome", 10).map((i) => i.message)).toEqual(["ten"]);
    expect(blockIssues(failures, "someone-else", 1)).toEqual([]);
  });

  // ONE CODE, TWO SECTIONS. rule 13 reports image_unknown for a screen picture and
  // for an answer tile alike; only the PATH says which list to print it in.
  // MUTATION: map by code and a broken answer tile is reported under the blocks.
  it("tells a screen picture from an answer picture by its path, not its code", () => {
    const g = invisalign();
    const broken = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === "q-smile_concern"
          ? { ...n, optionImages: [{ value: "crowded", image: "conditions/does-not-exist" }] }
          : n,
      ),
    } as FlowGraph;
    const issues = nodeIssues(broken, validateFlow(broken).failures, "q-smile_concern");
    expect(issuesFor(issues, "answer-images").map((i) => i.code)).toContain("image_unknown");
    expect(issuesFor(issues, "blocks")).toEqual([]);
  });

  // Rule 14's ragged message is the ONLY statement of that rule the owner gets -
  // the op deliberately allows a half-finished grid - so it has to reach the
  // section the pictures are in rather than the head of the rail.
  it("puts the ragged-grid rule under the answer pictures, in words", () => {
    const half = must(
      applyInspectorEdit(invisalign(), at("q-smile_concern"), {
        kind: "option-image",
        value: "crowded",
        image: "conditions/crowded",
      }),
    );
    const issues = nodeIssues(half, validateFlow(half).failures, "q-smile_concern");
    const ragged = issuesFor(issues, "answer-images").find((i) => i.code === "option_images_ragged");
    expect(ragged?.message).toContain("Give every answer a picture");
    expect(ragged?.message).toContain("unsure");
  });

  it("puts a misplaced block on the section that would have held it", () => {
    const g = invisalign();
    const wrong = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === "contact" ? { ...n, blocks: [{ kind: "faq", items: [{ q: "Q", a: "A" }, { q: "Q2", a: "A2" }] }] } : n,
      ),
    } as FlowGraph;
    const issues = nodeIssues(wrong, validateFlow(wrong).failures, "contact");
    expect(issuesFor(issues, "blocks").map((i) => i.code)).toContain("blocks_wrong_screen");
  });
});
