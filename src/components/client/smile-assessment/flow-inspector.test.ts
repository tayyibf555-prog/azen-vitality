// CLICK THE SCREEN, EDIT THE SCREEN (A1), held at the seams a pure test cannot
// reach: that picking a screen opens THAT screen's editable surface, that the
// strip says which one is picked, and that the rail decides nothing on its way to
// the save.
//
// TECHNIQUE, and the split. vitest runs environment:"node" and collects only
// src/**\/*.test.ts, so this is renderToStaticMarkup for what the rail and the
// strip PAINT, plus the component sources read as text for what a static render
// cannot show: what a handler does, what the file imports, and where the one
// "use client" boundary is. Same split as flow-phone-mini.test.ts and
// campaign-recolour.test.ts.
//
// WHAT IS HELD ELSEWHERE and not restated here: what an edit does to a graph
// (flow-edit.test.ts), what a control MEANS and where a failure belongs
// (flow-inspect.test.ts), and every string on a mini (flow-phone-screen.test.ts).
// This suite is the wiring between them.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FLOW_LIMITS,
  blockCopyFields,
  blockKindsForScreen,
  type FlowBlock,
  type FlowGraph,
} from "@/lib/smile-assessment/flow";
import { validateFlow } from "@/lib/smile-assessment/flow-validate";
import { FLOW_TEMPLATES, templateForGoal } from "@/lib/smile-assessment/flow-templates";
import { insertionPoints, phoneFlowLayout } from "@/lib/smile-assessment/flow-phone-layout";
import { screenFor, type PhoneScreen } from "@/lib/smile-assessment/flow-phone-screen";
import { questionById } from "@/lib/smile-assessment/quiz";
import {
  addBlock,
  addableBlockKinds,
  describeEdge,
  noAddableBlockReason,
  starterBlock,
  insertableQuestionsAfter,
  optionImageRows,
  questionSwapWarning,
  swappableQuestions,
} from "@/lib/smile-assessment/flow-edit";
import { applyInspectorEdit, type FlowSelection } from "@/lib/smile-assessment/flow-inspect";
import {
  assistTargetKey,
  isAssistableBlockField,
  type AssistTarget,
} from "@/lib/smile-assessment/flow-assist";
import { assessImage } from "@/lib/assess/image-library";
import { FlowInspector } from "./flow-inspector";
import { FlowPhoneCanvas } from "./flow-phone-canvas";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(HERE, name), "utf8");

const inspectorSource = read("flow-inspector.tsx");
const builderSource = read("flow-builder.tsx");
const phoneCanvasSource = read("flow-phone-canvas.tsx");
const miniSource = read("flow-phone-mini.tsx");
const panelSource = read("campaigns-panel.tsx");

/** Source with comments stripped: what the file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** React escapes its way out; asserting on raw copy passes only by luck. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const invisalign = (): FlowGraph => templateForGoal("invisalign").build();

function nodeOf(graph: FlowGraph, id: string) {
  const found = graph.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

/**
 * The question picker's own markup.
 *
 * SCOPED, and it has to be: every "then go to" row lists EVERY step in the funnel
 * by title, so a whole-document search for a question's prompt finds it whether or
 * not the picker offers it - and a test that cannot fail is worse than no test.
 */
function picker(html: string, nodeId: string): string {
  const at = html.indexOf(`<select id="q-${nodeId}"`);
  expect(at, `no question picker for ${nodeId}`).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</select>", at));
}

function rail(graph: FlowGraph, selection: FlowSelection | null): string {
  return renderToStaticMarkup(
    createElement(FlowInspector, {
      graph,
      selection,
      failures: validateFlow(graph).failures,
      onEdit: () => {},
      onSelect: () => {},
    }),
  );
}

function strip(
  graph: FlowGraph,
  extra: {
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    faultyNodeIds?: ReadonlySet<string>;
    selectLabels?: ReadonlyMap<string, string>;
    onAddAfter?: (id: string) => void;
    addLabels?: ReadonlyMap<string, string>;
  } = {},
): string {
  const layout = phoneFlowLayout(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const screens = new Map<string, PhoneScreen>();
  for (const n of layout.nodes) {
    const node = byId.get(n.id);
    if (node) screens.set(n.id, screenFor(node, graph, {}, n.step));
  }
  return renderToStaticMarkup(
    createElement(FlowPhoneCanvas, { layout, screens, idPrefix: "t", ...extra }),
  );
}

/* ---------------------------------------------------------------------------
 * 1. SELECTION: the rail shows the screen that was picked.
 * ------------------------------------------------------------------------- */

describe("the rail opens on the step that was selected", () => {
  // MUTATION: draw the rail off the first question node, or off a copy of the
  // selection held inside it, and every screen on the strip opens the same
  // inspector - which is the one bug a click-to-edit builder cannot survive.
  it("shows THAT step's question, and not another step's", () => {
    const g = invisalign();
    const smile = rail(g, { kind: "node", id: "q-smile_concern" });
    const timeline = rail(g, { kind: "node", id: "q-timeline" });

    // The head names the step, and the picker is set to its question.
    expect(smile).toContain(esc(questionById("smile_concern")!.prompt));
    expect(picker(smile, "q-smile_concern")).toContain(
      `<option value="smile_concern" selected="">`,
    );
    expect(smile).not.toContain('<select id="q-q-timeline"');

    expect(picker(timeline, "q-timeline")).toContain(`<option value="timeline" selected="">`);
    expect(timeline).not.toContain('<select id="q-q-smile_concern"');
    // Its own lead-in line, not the other step's.
    expect(smile).toContain('id="tr-q-smile_concern"');
    expect(smile).not.toContain('id="tr-q-timeline"');
  });

  // MUTATION: hand the picker the whole bank. The list is swappableQuestions,
  // which asks the validator - so a question already asked on this path, or one
  // about another treatment, is not on it.
  it("offers exactly the swaps the validator allows, and marks the current one", () => {
    const g = invisalign();
    const options = picker(rail(g, { kind: "node", id: "q-smile_concern" }), "q-smile_concern");
    const choices = swappableQuestions(g, "q-smile_concern");
    expect(choices.length).toBeGreaterThan(1);
    for (const id of choices) {
      expect(options, `${id} missing from the picker`).toContain(esc(questionById(id)!.prompt));
    }
    // ...and NOTHING else in the bank: one option per allowed swap.
    expect(occurrences(options, "<option")).toBe(choices.length);
    // treatment_interest is asked earlier on this path, so offering it here would
    // ask the same thing twice (rule 8).
    expect(options).not.toContain('value="treatment_interest"');
    expect(options).toContain('<option value="smile_concern" selected="">');
  });

  // MUTATION: leave the picker enabled on a branched step and every choice on it
  // refuses - a control that looks live and does nothing.
  it("locks the picker on a step whose answers are routed one by one, and says why", () => {
    const g = invisalign();
    const html = rail(g, { kind: "node", id: "q-treatment_interest" });
    expect(html).toContain("disabled=");
    expect(html).toContain(esc("Point them the same way below"));
  });

  it("shows the copy fields each kind of screen actually has", () => {
    const g = invisalign();
    const welcome = rail(g, { kind: "node", id: "welcome" });
    expect(welcome).toContain('id="wh-welcome"');
    expect(welcome).toContain('id="wi-welcome"');

    const result = rail(g, { kind: "node", id: "result-high" });
    expect(result).toContain('id="hl-result-high"');
    // A result screen has no opening line and no question to pick.
    expect(result).not.toContain('id="wi-');
    expect(result).not.toContain('<select id="q-');
  });

  it("says so plainly when nothing is selected", () => {
    expect(rail(invisalign(), null)).toContain("Nothing selected");
  });
});

/* ---------------------------------------------------------------------------
 * 2. THE BRANCH LIST: where each answer goes, on the step it leaves.
 * ------------------------------------------------------------------------- */

describe("the rail lists where each answer goes", () => {
  // MUTATION: draw the rows off `edgesFrom` and re-derive the index, and two
  // answers pointed at the same screen become one row that edits the other's wire
  // (outgoingEdges exists for exactly this - flow-edit.test.ts holds the rule).
  it("draws one row per outgoing wire, each with its own destination picker", () => {
    const g = invisalign();
    const html = rail(g, { kind: "node", id: "q-treatment_interest" });
    // Two wires out of the treatment step: the Invisalign branch and the rest.
    expect(occurrences(html, 'aria-label="Where ')).toBe(2);
    // Named by the ANSWER a patient taps, off the question bank - not by the
    // node id the wire happens to point at.
    const branchLabel = questionById("treatment_interest")!.options.find(
      (o) => o.value === "invisalign",
    )!.label;
    expect(html).toContain(esc(`Where “${branchLabel}” goes`));
    expect(html).toContain(esc("Where “Anything else” goes"));
  });

  it("shows the three band routes on the contact step", () => {
    const html = rail(invisalign(), { kind: "node", id: "contact" });
    expect(occurrences(html, 'aria-label="Where ')).toBe(3);
    expect(html).toContain("High intent");
  });

  // MUTATION: drop the uncovered-answer list and the one failure an owner cannot
  // diagnose from the picture - an answer that leads nowhere - has no control.
  it("lists the answers that lead nowhere, with a way to route them", () => {
    const g = invisalign();
    const index = g.edges.findIndex((e) => e.from === "q-timeline" && e.answer === null);
    const narrowed: FlowGraph = {
      ...g,
      edges: g.edges.map((e, i) => (i === index ? { ...e, answer: "asap" } : e)),
    };
    const html = rail(narrowed, { kind: "node", id: "q-timeline" });
    expect(html).toContain("Answers that lead nowhere");
    expect(html).toContain("Route it");
  });

  /**
   * THE CONTACT STEP'S BANDS ARE ANSWERS TOO. Rule 3 reports an unrouted band the
   * same way it reports an unrouted option, and before A1's parity pass the rail
   * knew only about options - so a band route deleted with the Trash button in
   * this very list could not be put back from anywhere in the builder.
   *
   * MUTATION: narrow uncoveredAnswers to question steps and this goes red while
   * every other test stays green (a contact step with all three routes shows
   * nothing either way - that is the trap).
   */
  it("offers the repair for a band route deleted off the contact step", () => {
    const g = invisalign();
    const broken: FlowGraph = {
      ...g,
      edges: g.edges.filter((e) => !(e.from === "contact" && e.answer === "high")),
    };
    expect(validateFlow(broken).failures.some((f) => f.code === "band_uncovered")).toBe(true);

    const html = rail(broken, { kind: "node", id: "contact" });
    expect(html).toContain("Answers that lead nowhere");
    expect(html).toContain("High intent");
    expect(html).toContain("Route it");
  });

  /**
   * A STEP THAT LEADS NOWHERE. The empty branch list used to say "add a connection
   * on the wiring view below" - and the wiring view could not add one either. The
   * copy pointed at the component this pass retired, which is how the hole was
   * found; the control is what made retiring it honest.
   */
  it("connects a step that has no route out, from the rail itself", () => {
    const g = invisalign();
    const stranded: FlowGraph = { ...g, edges: g.edges.filter((e) => e.from !== "welcome") };
    const html = rail(stranded, { kind: "node", id: "welcome" });

    expect(html).toContain("This step leads nowhere");
    expect(html).not.toContain("wiring view");
    expect(html).toContain("Connect this step to");
    expect(html).toContain('id="link-welcome"');
    // Every other screen is offered, and never itself.
    const at = html.indexOf('id="link-welcome"');
    const picker = html.slice(at, html.indexOf("</select>", at));
    expect(occurrences(picker, "<option")).toBe(g.nodes.length); // the placeholder + n-1
    expect(picker).not.toContain('value="welcome"');

    // ...and it is not offered on a step that already leads somewhere, nor on a
    // result step, which is terminal by rule 7 and correct as a dead end.
    expect(rail(g, { kind: "node", id: "welcome" })).not.toContain("Connect this step to");
    expect(rail(g, { kind: "node", id: "result-high" })).not.toContain("Connect this step to");
  });

  // MUTATION: leave the order of the branches to the shape of the graph. It is the
  // order they are DRAWN in, and on a step with no "anything else" wire it is also
  // the route a deleted predecessor re-points to (defaultEdgeOf).
  it("puts the branch order on the rows, and only where there is an order", () => {
    const g = invisalign();
    const branched = rail(g, { kind: "node", id: "q-treatment_interest" });
    expect(occurrences(branched, 'aria-label="Move ')).toBe(4); // two rows, up and down
    expect(branched).toContain(esc("” up"));
    expect(branched).toContain(esc("” down"));

    // One wire out: nothing to reorder, so no controls at all.
    expect(rail(g, { kind: "node", id: "q-timeline" })).not.toContain('aria-label="Move ');
  });

  /**
   * ADD A SCREEN, FROM THE STEP. The + on the strip does this in one click; the
   * rail is where the question is CHOSEN, and it is the only one of the two that
   * exists at phone width, where the strip has no gutters to put a + in.
   */
  it("offers the questions that may follow this step, and none that may not", () => {
    const g = invisalign();
    const html = rail(g, { kind: "node", id: "q-timeline" });
    expect(html).toContain("Add a screen after this one");

    const at = html.indexOf('id="add-q-timeline"');
    expect(at, "no add-a-screen picker").toBeGreaterThan(-1);
    const picker = html.slice(at, html.indexOf("</select>", at));
    const offered = insertableQuestionsAfter(g, "q-timeline");
    expect(offered.length).toBeGreaterThan(0);
    for (const id of offered) {
      expect(picker, `${id} is not offered`).toContain(esc(questionById(id)!.prompt));
    }
    // Rule 8: the question this step already asks is not on the list.
    expect(picker).not.toContain(esc(questionById("timeline")!.prompt));

    // A terminal step has no wire to splice into, so the control is absent rather
    // than present and permanently refusing.
    expect(rail(g, { kind: "node", id: "result-high" })).not.toContain(
      "Add a screen after this one",
    );
  });
});

/* ---------------------------------------------------------------------------
 * 3. VALIDATION, BESIDE THE FIELD IT IS ABOUT.
 * ------------------------------------------------------------------------- */

describe("a failure is printed next to the control that fixes it", () => {
  // MUTATION: leave the failures to the banner alone. The banner is above the
  // canvas and lists everything; the owner fixing one step is looking at the rail.
  it("prints an uncovered answer under the branch list, in the rail", () => {
    const g = invisalign();
    const index = g.edges.findIndex((e) => e.from === "q-timeline" && e.answer === null);
    const narrowed: FlowGraph = {
      ...g,
      edges: g.edges.map((e, i) => (i === index ? { ...e, answer: "asap" } : e)),
    };
    const failures = validateFlow(narrowed).failures;
    const uncovered = failures.find((f) => f.code === "option_uncovered");
    expect(uncovered).toBeTruthy();
    expect(rail(narrowed, { kind: "node", id: "q-timeline" })).toContain(esc(uncovered!.message));
  });

  it("prints a step with no question under its picker", () => {
    const g = invisalign();
    const broken: FlowGraph = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === "q-timeline" ? { id: n.id, kind: "question", questionId: "not_a_question" } : n,
      ),
    };
    const html = rail(broken, { kind: "node", id: "q-timeline" });
    expect(html).toContain("not in the question bank");
    // ...and the picker still names what the step is set to, or it would render
    // as somebody else's question.
    expect(html).toContain(esc("Not in the question bank: “not_a_question”"));
  });
});

/* ---------------------------------------------------------------------------
 * 4. THE STRIP: selectable, and only when it is meant to be.
 * ------------------------------------------------------------------------- */

describe("the phone strip carries the selection", () => {
  // MUTATION: ring every screen, or none. The ring is the answer to "which screen
  // am I editing" and there is exactly one answer.
  it("rings exactly the selected screen, in both renderings", () => {
    const g = invisalign();
    const html = strip(g, { selectedId: "q-timeline", onSelect: () => {} });
    const nodes = phoneFlowLayout(g).nodes.length;
    // One button per screen, twice over: the strip and the small-screen list.
    expect(occurrences(html, "<button")).toBe(nodes * 2);
    expect(occurrences(html, 'aria-pressed="true"')).toBe(2);
    expect(occurrences(html, 'aria-pressed="false"')).toBe((nodes - 1) * 2);
    expect(html).toContain("ring-blue-royal");
  });

  // MUTATION: mark a broken step with the selection ring and the two states -
  // "this is the one I am editing" and "this one is broken" - stop being
  // distinguishable.
  it("rings a step a failure named in the danger colour, and selection still wins", () => {
    const g = invisalign();
    const faulty = strip(g, { onSelect: () => {}, faultyNodeIds: new Set(["q-timeline"]) });
    expect(occurrences(faulty, "ring-danger")).toBe(2);

    const both = strip(g, {
      selectedId: "q-timeline",
      onSelect: () => {},
      faultyNodeIds: new Set(["q-timeline"]),
    });
    expect(occurrences(both, "ring-danger")).toBe(0);
    expect(occurrences(both, 'aria-pressed="true"')).toBe(2);
  });

  // MUTATION: name the buttons in the strip and it has to read the question bank -
  // the import flow-phone-mini.test.ts bans, and the reason describeNode's
  // owner-facing words are computed by the builder and passed in as data.
  it("wears the labels it is handed, and writes none of its own", () => {
    const html = strip(invisalign(), {
      onSelect: () => {},
      selectLabels: new Map([["q-timeline", "Question: When would you like to start?"]]),
    });
    expect(html).toContain('aria-label="Question: When would you like to start?"');
    expect(codeOnly(phoneCanvasSource)).not.toContain("describeNode");
    expect(codeOnly(phoneCanvasSource)).not.toContain("questionById");
  });

  // MUTATION: leave the wrapper role="img" once it holds buttons. A control
  // inside an image role is a control no screen reader can reach.
  it("stops being a picture the moment it becomes editable", () => {
    expect(strip(invisalign(), { onSelect: () => {} })).toContain('role="group"');
    expect(strip(invisalign())).toContain('role="img"');
  });

  // MUTATION: position the minis inside the button and the wires - drawn at the
  // layout's coordinates on a layer that knows nothing about selection - stop
  // meeting the screens' edges.
  it("leaves the positioning to the layout, with the button inside it", () => {
    const g = invisalign();
    const html = strip(g, { onSelect: () => {} });
    for (const n of phoneFlowLayout(g).nodes) {
      expect(html).toContain(`left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px`);
    }
    expect(html).not.toContain("transform");
  });

  /* ---------------------------------------------------------------------------
   * THE + BETWEEN THE SCREENS: A1's add-a-screen affordance on the canvas itself.
   * ------------------------------------------------------------------------- */

  // MUTATION: place the + by hand ("x + w + 44") and the arithmetic leaves the
  // module a test can reach. Every number below is insertionPoints'.
  it("draws a + in the gutter after every screen that has a wire out", () => {
    const g = invisalign();
    const points = insertionPoints(phoneFlowLayout(g));
    const html = strip(g, { onSelect: () => {}, onAddAfter: () => {} });

    for (const p of points) {
      expect(html, `no + after ${p.nodeId}`).toContain(
        `left:${p.x}px;top:${p.y}px;width:${p.size}px;height:${p.size}px`,
      );
    }
    // One on the strip and one in the small-screen list, per screen that gets one
    // (each carries the same words twice over, as its name and as its tooltip).
    expect(occurrences(html, 'aria-label="Add a screen after')).toBe(points.length * 2);
    // ...and none on a result step, which is terminal and has nothing to add to.
    expect(points.some((p) => p.nodeId === "result-high")).toBe(false);
  });

  // MUTATION: make the + unconditional and the wizard's stage-2 preview - a funnel
  // with no campaign to be saved against - grows an editing control per screen.
  it("has no + at all without a callback for it", () => {
    const g = invisalign();
    const html = strip(g, { onSelect: () => {} });
    expect(html).not.toContain("Add a screen after");
    const nodes = phoneFlowLayout(g).nodes.length;
    expect(occurrences(html, "<button")).toBe(nodes * 2);
  });

  // MUTATION: name every + the same and the a11y tree has nine identical "add"
  // buttons on a nine-step funnel. The name is the builder's, off describeNode -
  // this file may not read the question bank (flow-phone-mini.test.ts pins it).
  it("wears the + labels it is handed", () => {
    const html = strip(invisalign(), {
      onSelect: () => {},
      onAddAfter: () => {},
      addLabels: new Map([["welcome", "Add a screen after “Welcome screen”"]]),
    });
    expect(html).toContain(esc('Add a screen after “Welcome screen”'));
    // Anything unnamed still says what it does.
    expect(html).toContain("Add a screen after this one");
  });
});

/* ---------------------------------------------------------------------------
 * 5. THE WIRING: one selection, two canvases, one save.
 * ------------------------------------------------------------------------- */

describe("the builder holds the selection and the graph", () => {
  const code = codeOnly(builderSource);

  // MUTATION: give the strip its own selection state and the ring on the phone and
  // the rail beside it become two answers to "what am I editing".
  //
  // PIN CHANGED: this used to require "<FlowCanvas" and its `selectedNodeId` here
  // too, when the builder mounted both canvases off one selection. One canvas is
  // left; what still has to hold is that the strip and the rail read the SAME
  // selection, which is what the two remaining assertions say.
  it("drives the strip and the rail from ONE selection", () => {
    expect(occurrences(code, "useState<FlowSelection | null>(null)")).toBe(1);
    expect(code).toContain("<FlowPhoneCanvas");
    expect(code).toContain("selectedId={selected?.kind === \"node\" ? selected.id : null}");
    expect(code).toContain("selection={selected}");
  });

  /**
   * THE RETIREMENT, held as the thing it actually turned on.
   *
   * PIN REPLACED. Its predecessor said "keeps the wiring canvas mounted and
   * selectable", on the argument that the cards were the only place a CONNECTION
   * could be picked. That was true of the drawing and false of the builder: every
   * wire out of a step is a row in that step's rail, and every step is a button on
   * the strip. So the claim worth pinning is not "the canvas is mounted" but
   * "nothing became unreachable when it came down" - which is checkable, per
   * connection, against a real funnel.
   *
   * MUTATION: drop the "Edit" button off a branch row (or draw the rows off
   * `edgesFrom` instead of `outgoingEdges`, losing the index) and a connection
   * becomes uneditable, with the drawing that used to reach it gone.
   */
  it("leaves every connection reachable from the strip, with the cards gone", () => {
    expect(code).not.toContain("<FlowCanvas");
    expect(builderSource).not.toContain("./flow-canvas");
    expect(code).toContain("onSelect={(id) => select({ kind: \"node\", id })}");

    const g = invisalign();
    const onStrip = new Set(phoneFlowLayout(g).nodes.map((n) => n.id));
    for (const node of g.nodes) {
      expect(onStrip, `${node.id} is not on the strip`).toContain(node.id);
    }

    // ...INCLUDING A STEP NOTHING LEADS TO. Rule 5 names it in the banner, and a
    // step the banner names has to be selectable or the failure is unfixable. The
    // layout parks a stranded node rather than dropping it, so the strip carries
    // it exactly as the card canvas did.
    const orphaned: FlowGraph = {
      ...g,
      edges: g.edges.filter((e) => !(e.from === "contact" && e.answer === "high")),
    };
    const orphanFailure = validateFlow(orphaned).failures.find((f) => f.code === "orphan");
    expect(orphanFailure?.where).toBe("result-high");
    expect(phoneFlowLayout(orphaned).nodes.map((n) => n.id)).toContain("result-high");
    expect(rail(orphaned, { kind: "node", id: "result-high" })).toContain('id="hl-result-high"');
    // ...and each of its wires is a row, with the index that addresses it, in the
    // rail of the step it leaves.
    g.edges.forEach((edge, index) => {
      const html = rail(g, { kind: "node", id: edge.from });
      expect(html, `edge ${index} (${edge.from} -> ${edge.to}) has no row`).toContain(
        `Where “${esc(describeEdge(edge, nodeOf(g, edge.from)) ?? "Straight on")}” goes`,
      );
      // Opening that connection's own rail from the row is what replaces clicking
      // the wire on the retired canvas.
      expect(rail(g, { kind: "edge", index })).toContain("Taken when the answer is");
    });
  });

  // MUTATION: have the + select the screen and open something, or add the screen
  // in the strip. It is one intent, through the one channel every other control
  // uses, so its refusal ("nothing left to add on this route") surfaces in the
  // same banner - and a + that cannot act SAYS so rather than doing nothing.
  it("turns the strip's + into the same edit intent as everything else", () => {
    expect(code).toContain('onAddAfter={(id) => onEdit({ kind: "add-screen", nodeId: id })}');
    expect(code).toContain("addLabels={addLabels}");
    // Named off the same card the selection label is: one description per step.
    expect(code).toContain("add.set(n.id, `Add a screen after “${card.title}”`)");
  });

  // MUTATION: apply the intent in the rail. The rail would then need the graph,
  // the ops and the refusal channel - which is the whole of the builder, moved
  // into a file no test can drive.
  it("turns a rail intent into a pure edit result, and nothing else", () => {
    expect(code).toContain("const result = applyInspectorEdit(graph, selected, edit);");
    expect(code).toContain("onEdit={onEdit}");
    // The refusal is shown, never swallowed: `apply` is the one channel.
    expect(code).toContain("setRefusal(result.reason)");
  });

  // MUTATION: the one this cost a rewrite. Clearing the selection alongside a
  // destructive edit clears the REFUSAL with it (moving the selection resets it),
  // so "connect it first" never reaches the screen and the button reads as dead.
  // PIN CHANGED: selectionAfterEdit now takes the PRE-EDIT graph as well, so an
  // insertion can be answered with the step it just made. Handing it `result.graph`
  // would make the planner name a step against a funnel that already holds it.
  it("moves the selection only when the edit landed, and never from the rail", () => {
    expect(code).toContain(
      "if (result.ok) setSelected((current) => selectionAfterEdit(current, edit, graph));",
    );
    // The rail fires the edit and nothing else: no destructive button clears the
    // selection on its own.
    const railCode = codeOnly(inspectorSource);
    for (const kind of ["remove-node", "remove-edge", "insert-question"]) {
      const at = railCode.indexOf(`kind: "${kind}"`);
      expect(at, `${kind} is not fired from the rail`).toBeGreaterThan(-1);
      // ...and the next 120 characters of that handler do not clear the selection.
      expect(railCode.slice(at, at + 120)).not.toContain("onSelect(null)");
    }
  });

  // MUTATION: send the draft graph anywhere but the one PUT route with its
  // expectedVersion, and the compliance scan, the server-side validation and the
  // version bump are all bypassed.
  it("saves the edited draft through the one flow route, with its version check", () => {
    expect(code).toContain("flow: graph,");
    expect(code).toContain("expectedVersion: version");
    expect(code).toContain('method: "PUT"');
    expect(occurrences(code, "await fetch(")).toBe(1);
    expect(code).toContain(
      "/api/smile-assessment/campaign/${encodeURIComponent(campaignSlug)}/flow?client=${encodeURIComponent(clientSlug)}",
    );
  });

  // MUTATION: put the Escape handler on `document` and a builder inside a dialog
  // swallows that dialog's Escape. MUTATION: drop it and the only way out of a
  // selection is the mouse.
  it("deselects on Escape, from the container, only when something is selected", () => {
    expect(code).toContain('if (event.key !== "Escape" || selected === null) return;');
    expect(code).toContain("select(null);");
    expect(code).not.toContain("document.addEventListener");
    expect(code).not.toContain("window.addEventListener");
  });

  // The bonus: arrows walk the strip. MUTATION: put this handler on the builder
  // and an arrow key inside a text field in the rail moves the selection instead
  // of the cursor.
  it("walks the strip with the arrow keys, scoped to the strip", () => {
    expect(code).toContain('event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0');
    expect(code).toContain("stepAfter(");
    const handlerAt = code.indexOf("ArrowRight");
    const stripAt = code.indexOf("<FlowPhoneCanvas");
    const railAt = code.indexOf("<FlowInspector");
    expect(handlerAt).toBeLessThan(stripAt);
    expect(handlerAt).toBeLessThan(railAt);
  });
});

/* ---------------------------------------------------------------------------
 * 6. THE DOCTRINE: rules in pure modules, components dumb - and the RSC boundary.
 * ------------------------------------------------------------------------- */

describe("the rail decides nothing", () => {
  const code = codeOnly(inspectorSource);

  // MUTATION: call setWelcomeCopy (or addEdge, or removeNode) from a handler in
  // the rail. Every one of those calls carries a rule - which field to re-send,
  // where an unrouted answer goes - into a file vitest collects nothing from.
  it("imports only READ helpers from flow-edit: not one write op", () => {
    for (const op of [
      "setWelcomeCopy",
      "setOutcomeHeadline",
      "setQuestionTransition",
      "setNodeQuestion",
      "setEdgeAnswer",
      "setEdgeTarget",
      "setEdgeTransition",
      "addEdge",
      "removeEdge",
      "removeNode",
      "insertQuestionOnEdge",
    ]) {
      expect(code, `the rail calls ${op}`).not.toContain(op);
    }
    // ...and it applies nothing either: the builder owns the draft graph.
    expect(code).not.toContain("applyInspectorEdit");
    expect(code).not.toContain("setGraph");
    expect(code).not.toContain("fetch(");
  });

  // MUTATION: build the choices, the uncovered answers or the branch rows by
  // hand here and each becomes a second copy of a rule that already exists.
  // PIN CHANGED: `uncoveredOptions` is now `uncoveredAnswers` - the same rule,
  // generalised off routableAnswers so it covers the contact step's bands as well
  // as a question's options, which is what rule 3 has always reported. The list
  // grew by the helpers A1's parity pass added.
  it("reads its lists from the pure layer", () => {
    for (const helper of [
      "swappableQuestions",
      "insertableQuestions",
      "insertableQuestionsAfter",
      "outgoingEdges",
      "uncoveredAnswers",
      "connectableTargets",
      "routableAnswers",
      "routedAnswers",
      "nodeIssues",
      "edgeIssues",
    ]) {
      expect(code, `${helper} is not read from the pure layer`).toContain(helper);
    }
    // The destination pickers all read the same list: three copies of
    // `.filter((n) => n.id !== ...)` is three chances to offer a self-loop.
    expect(code).not.toContain("graph.nodes.filter");
  });

  // THE RSC CLIENT-BOUNDARY TRAP (memory: rsc-client-boundary-datatable-tabs). A
  // component with FUNCTION props that declares "use client" of its own becomes a
  // boundary: a server parent then passes functions across it and the page throws
  // at render, with a build that passed. The whole funnel-builder subtree takes
  // callbacks, so not one file in it may declare the directive - the panel above
  // them is the single boundary, and every one of them is reached only through it.
  it("puts the only 'use client' on the panel, above every component that takes a callback", () => {
    const CLIENT = /^\s*["']use client["']/m;
    expect(CLIENT.test(panelSource), "the panel must be the boundary").toBe(true);
    for (const [name, source] of [
      ["flow-inspector.tsx", inspectorSource],
      ["flow-builder.tsx", builderSource],
      ["flow-phone-canvas.tsx", phoneCanvasSource],
      ["flow-phone-mini.tsx", miniSource],
      ["flow-canvas.tsx", read("flow-canvas.tsx")],
    ] as const) {
      expect(CLIENT.test(source), `${name} declares 'use client' and becomes a boundary`).toBe(
        false,
      );
    }
  });

  // MUTATION: mount the strip from a server component "because it is only a
  // picture". It takes an onSelect now; the two importers are the panel (a client
  // module) and the builder underneath it.
  it("is reached only from the client subtree", () => {
    for (const [name, source] of [
      ["campaigns-panel.tsx", panelSource],
      ["flow-builder.tsx", builderSource],
    ] as const) {
      expect(source, `${name} should import the strip`).toContain("./flow-phone-canvas");
    }
    // The panel's own preview stays read-only: no campaign, nothing to save to.
    const panelStrip = panelSource.slice(
      panelSource.indexOf("<FlowPhoneCanvas"),
      panelSource.indexOf("/>", panelSource.indexOf("<FlowPhoneCanvas")),
    );
    expect(panelStrip).not.toContain("onSelect");
  });
});

/* ---------------------------------------------------------------------------
 * 7. THE PARITY CHECKLIST, as one inventory.
 *
 * The abstract card canvas came down in this pass. What justified that is not an
 * argument about drawings - it is that every operation the builder offers is
 * reachable by picking a SCREEN on the strip and using its rail. This walks every
 * step of every template and asserts the controls that step's kind must carry, so
 * a kind that renders an empty rail (or loses one control on one kind) goes red
 * here rather than being discovered by an owner with a broken funnel.
 * ------------------------------------------------------------------------- */

describe("every operation is reachable from a screen", () => {
  const EVERY = FLOW_TEMPLATES.map((t) => ({ key: t.key, graph: t.build() }));

  it("covers the templates it thinks it covers", () => {
    expect(EVERY.length).toBeGreaterThan(1);
    for (const { key, graph } of EVERY) {
      expect(validateFlow(graph).ok, `${key} does not validate`).toBe(true);
      for (const kind of ["welcome", "question", "contact", "outcome"]) {
        expect(graph.nodes.some((n) => n.kind === kind), `${key} has no ${kind}`).toBe(true);
      }
    }
  });

  it.each(EVERY.map((e) => e.key))("%s: every step's rail carries its own controls", (key) => {
    const graph = EVERY.find((e) => e.key === key)!.graph;

    for (const node of graph.nodes) {
      const html = rail(graph, { kind: "node", id: node.id });
      const has = (needle: string, what: string) =>
        expect(html, `${node.id} (${node.kind}): no ${what}`).toContain(needle);

      // Every rail names the step it opened on and can be closed.
      has("Close the inspector", "way out");

      if (node.kind === "question") {
        has(`id="q-${node.id}"`, "question picker");
        has(`id="tr-${node.id}"`, "lead-in field");
        has("Remove this question", "remove control");
        has("Add a screen after this one", "add-a-screen control");
      }
      if (node.kind === "welcome") {
        has(`id="wh-${node.id}"`, "headline field");
        has(`id="wi-${node.id}"`, "intro field");
        has("Add a screen after this one", "add-a-screen control");
        // The entry is not removable, and the rail does not pretend otherwise.
        expect(html, "the welcome step offers a remove").not.toContain("Remove this question");
      }
      if (node.kind === "outcome") {
        has(`id="hl-${node.id}"`, "result headline field");
        // Terminal by rule 7: no branches, nothing to add after it.
        expect(html).not.toContain("Add a screen after this one");
      }

      // Everything that routes shows where each answer goes, with a destination
      // picker and a way into the connection's own rail per wire.
      const wires = graph.edges.filter((e) => e.from === node.id);
      if (wires.length > 0) {
        has("Where each answer goes", "branch list");
        expect(occurrences(html, 'aria-label="Where '), `${node.id}: a row per wire`).toBe(
          wires.length,
        );
        expect(occurrences(html, ">Edit</button>"), `${node.id}: a way into each wire`).toBe(
          wires.length,
        );
        expect(
          occurrences(html, 'aria-label="Remove the connection'),
          `${node.id}: a way to remove each wire`,
        ).toBe(wires.length);
        expect(occurrences(html, 'aria-label="Move '), `${node.id}: reorder controls`).toBe(
          wires.length > 1 ? wires.length * 2 : 0,
        );
      }
    }

    // ...and every connection's own rail carries its three fields plus the
    // splice-a-question control the retired canvas used to be the way into.
    graph.edges.forEach((_, index) => {
      const html = rail(graph, { kind: "edge", index });
      for (const needle of [
        "Taken when the answer is",
        "Then go to",
        `id="etr-${index}"`,
        "Add a question here",
        "Remove this connection",
      ]) {
        expect(html, `edge ${index}: no ${needle}`).toContain(needle);
      }
    });
  });
});

/* ---------------------------------------------------------------------------
 * 8. A2's BUILDER SURFACE: content blocks, and pictures on the answer cards.
 *
 * The last thing in the funnel that could be authored by a generator and by
 * nothing else. What is held here is the WIRING - that the sections appear on the
 * screens that can carry them and nowhere else, that every authored line has a
 * box, that a picture is picked rather than typed - and not the rules, which are
 * flow-edit.test.ts's and flow-inspect.test.ts's.
 * ------------------------------------------------------------------------- */

/** The same funnel with two blocks on its welcome screen, in authored order. */
function withFurniture(): FlowGraph {
  const g = invisalign();
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === "welcome"
        ? {
            ...n,
            blocks: [
              { kind: "trust-strip", practiceName: "Vitality Dental", chips: ["Open Saturdays", "Free parking"] },
              { kind: "faq", items: [{ q: "How long?", a: "About 30 seconds." }, { q: "Then what?", a: "We call you." }] },
            ],
          }
        : n,
    ),
  } as FlowGraph;
}

describe("the blocks section", () => {
  // MUTATION: draw it on every rail. A question screen's job is the one question
  // and the contact screen's is the form (flow.ts, FLOW_BLOCK_SCREEN_KINDS); rule
  // 12 refuses a block on either, so a section there is a control that can only
  // produce a funnel that will not publish.
  it("is on the screens that can carry blocks, and on no others", () => {
    const g = invisalign();
    expect(rail(g, { kind: "node", id: "welcome" })).toContain("Blocks on this screen");
    expect(rail(g, { kind: "node", id: "result-high" })).toContain("Blocks on this screen");
    expect(rail(g, { kind: "node", id: "q-timeline" })).not.toContain("Blocks on this screen");
    expect(rail(g, { kind: "node", id: "contact" })).not.toContain("Blocks on this screen");
  });

  it("offers exactly the kinds that screen has not got yet", () => {
    const empty = rail(invisalign(), { kind: "node", id: "welcome" });
    const at = empty.indexOf('<select id="ab-welcome"');
    const kinds = empty.slice(at, empty.indexOf("</select>", at));
    // One "choose a kind" placeholder plus one per addable kind.
    expect(occurrences(kinds, "<option")).toBe(addableBlockKinds(invisalign(), "welcome").length + 1);
    for (const kind of addableBlockKinds(invisalign(), "welcome")) {
      expect(kinds).toContain(`value="${kind}"`);
    }

    // ...and the two already on the screen are gone from the picker.
    const full = rail(withFurniture(), { kind: "node", id: "welcome" });
    const at2 = full.indexOf('<select id="ab-welcome"');
    const left = full.slice(at2, full.indexOf("</select>", at2));
    expect(left).not.toContain('value="faq"');
    expect(left).not.toContain('value="trust-strip"');
    expect(left).toContain('value="testimonial"');
  });

  // AN EMPTY PICKER HAS TO SAY WHY, AND THE TWO WHYS ARE DIFFERENT.
  //
  // A result screen accepts five block kinds and holds at most four
  // (FLOW_LIMITS.blocksPerNode), so a full one always has a kind it will never be
  // offered. The rail used to answer that with "this screen has one of every kind
  // of block", which is false there and sends the owner looking for a kind to
  // change instead of one to remove. The sentence is flow-edit's
  // (noAddableBlockReason) precisely so the rail cannot come to its own view of a
  // rule it does not own.
  //
  // MUTATION: restore the single hard-coded sentence in the rail and the result
  // screen below reads back a statement about the funnel that is not true of it.
  it("says which of the two reasons the picker is empty for", () => {
    // The opening screen, holding one of each of the four kinds it may carry.
    const kinds = blockKindsForScreen("welcome");
    let welcome = invisalign();
    for (const kind of kinds) {
      const block =
        kind === "testimonial"
          ? ({ kind: "testimonial", quote: "They explained every step.", attribution: "Jo B." } as FlowBlock)
          : starterBlock(kind, "Vitality Dental");
      if (!block) throw new Error(`no starter for ${kind}`);
      const edited = addBlock(welcome, "welcome", block);
      if (!edited.ok) throw new Error(edited.reason);
      welcome = edited.graph;
    }
    const wHtml = rail(welcome, { kind: "node", id: "welcome" });
    expect(wHtml).not.toContain('<select id="ab-welcome"');
    expect(wHtml).toContain(esc(noAddableBlockReason(welcome, "welcome")!));
    expect(wHtml).toContain("one of every kind");

    // The result screen, FULL at four of its five kinds.
    const outcomeKinds = blockKindsForScreen("outcome");
    expect(outcomeKinds.length).toBeGreaterThan(FLOW_LIMITS.blocksPerNode);
    let result = invisalign();
    for (const kind of outcomeKinds.slice(0, FLOW_LIMITS.blocksPerNode)) {
      const block =
        kind === "testimonial"
          ? ({ kind: "testimonial", quote: "They explained every step.", attribution: "Jo B." } as FlowBlock)
          : starterBlock(kind, "Vitality Dental");
      if (!block) throw new Error(`no starter for ${kind}`);
      const edited = addBlock(result, "result-high", block);
      if (!edited.ok) throw new Error(edited.reason);
      result = edited.graph;
    }
    const rHtml = rail(result, { kind: "node", id: "result-high" });
    expect(rHtml).not.toContain('<select id="ab-result-high"');
    expect(rHtml).toContain(esc(noAddableBlockReason(result, "result-high")!));
    // The wording an owner acts on: the screen is full, not complete.
    expect(rHtml).toContain("full");
    expect(rHtml).not.toContain("one of every kind");

    // A screen with room still gets the picker and no sentence at all.
    const roomy = rail(invisalign(), { kind: "node", id: "welcome" });
    expect(roomy).toContain('<select id="ab-welcome"');
    expect(roomy).not.toContain("one of every kind");
  });

  // EVERY AUTHORED LINE HAS A BOX, and the list is blockCopyFields' - the same one
  // rule 12 caps and the compliance scan reads. MUTATION: draw a fixed set of
  // fields per kind here and a chip added by the generator becomes uneditable.
  it("draws one box per line blockCopyFields names, carrying that line's words", () => {
    const g = withFurniture();
    const html = rail(g, { kind: "node", id: "welcome" });
    const blocks = nodeOf(g, "welcome");
    const list = blocks.kind === "welcome" ? (blocks.blocks ?? []) : [];
    expect(list).toHaveLength(2);

    list.forEach((block, index) => {
      for (const field of blockCopyFields(block)) {
        const id = `bf-welcome-${index}-${field.field.replace(/[^a-z0-9]/gi, "")}`;
        expect(html, `no box for ${block.kind}.${field.field}`).toContain(`id="${id}"`);
        expect(html, `${field.field} does not carry its words`).toContain(esc(field.text));
      }
    });
    // Both blocks, in authored order: the order they render in.
    expect(html.indexOf("trust strip")).toBeLessThan(html.indexOf("questions and answers"));
  });

  it("gives every block a way up, a way down and a way out", () => {
    const html = rail(withFurniture(), { kind: "node", id: "welcome" });
    expect(html).toContain('aria-label="Move the trust strip down"');
    expect(html).toContain('aria-label="Move the questions and answers up"');
    expect(html).toContain('aria-label="Remove the trust strip"');
    expect(html).toContain('aria-label="Remove the questions and answers"');
    // A screen with ONE block has nothing to reorder, so it is not offered.
    const one = invisalign();
    const single = {
      ...one,
      nodes: one.nodes.map((n) =>
        n.id === "result-low" ? { ...n, blocks: [{ kind: "faq", items: [{ q: "A", a: "B" }, { q: "C", a: "D" }] }] } : n,
      ),
    } as FlowGraph;
    expect(rail(single, { kind: "node", id: "result-low" })).not.toContain('aria-label="Move the');
  });

  // THE CHARTER RULE, ON THE SURFACE THAT COULD BREAK IT. The add control asks
  // for the practice's own words and says, in the rail, that nothing here writes
  // one - and the refusal behind it lives in flow-inspect.ts, not in `disabled`.
  it("says a testimonial is the practice's own words, and never starts one", () => {
    const code = codeOnly(inspectorSource);
    // Said where the owner is choosing what to add, not only once the fields for
    // it appear: a rule behind a state change is a rule most owners never read.
    expect(rail(invisalign(), { kind: "node", id: "welcome" })).toContain(
      esc("A testimonial is the practice's own words"),
    );
    expect(rail(invisalign(), { kind: "node", id: "welcome" })).toContain(
      esc("nothing here writes one for you"),
    );
    expect(code).toContain("kind: \"add-block\"");
    // The words travel with the intent: the rail cannot make the block itself.
    expect(code).toContain("quote,");
    expect(code).toContain("attribution,");
    expect(code).not.toContain("kind: \"testimonial\"");
    expect(code).not.toContain("starterBlock");
  });

  it("prints a block's own failures against the box that fixes them", () => {
    const g = invisalign();
    const broken = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === "welcome"
          ? { ...n, blocks: [{ kind: "faq", items: [{ q: "Only one", a: "Answer" }] }] }
          : n,
      ),
    } as FlowGraph;
    const failure = validateFlow(broken).failures.find((f) => f.code === "faq_item_count");
    expect(failure).toBeTruthy();
    expect(rail(broken, { kind: "node", id: "welcome" })).toContain(esc(failure!.message));
  });
});

describe("pictures on the answer cards", () => {
  it("is on a question rail only, with a row per answer", () => {
    const g = invisalign();
    const html = rail(g, { kind: "node", id: "q-smile_concern" });
    expect(html).toContain("Pictures on the answers");
    const rows = optionImageRows(g, "q-smile_concern");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(html, `no row for ${row.value}`).toContain(esc(row.label));
    expect(occurrences(html, 'aria-expanded="false"')).toBe(rows.length);

    expect(rail(g, { kind: "node", id: "welcome" })).not.toContain("Pictures on the answers");
    expect(rail(g, { kind: "node", id: "contact" })).not.toContain("Pictures on the answers");
  });

  // RULE 14's RELAXATION, SAID ON THE ROW IT APPLIES TO. Every other unpictured
  // answer says "no picture yet"; the last one says it is allowed.
  it("says which answer may be left without a picture", () => {
    const html = rail(invisalign(), { kind: "node", id: "q-smile_concern" });
    expect(occurrences(html, "No picture, which is allowed on the last answer")).toBe(1);
    expect(html).toContain("Give every answer a picture, or leave only the last one without");
  });

  it("shows the picture an answer has, with a way to change it and a way to take it off", () => {
    const g = invisalign();
    const pictured = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === "q-smile_concern"
          ? { ...n, optionImages: [{ value: "crowded", image: "conditions/crowded" }] }
          : n,
      ),
    } as FlowGraph;
    const html = rail(pictured, { kind: "node", id: "q-smile_concern" });
    const image = assessImage("conditions/crowded")!;
    expect(html).toContain(`src="${image.path}"`);
    expect(html).toContain(esc(image.alt));
    expect(html).toContain(">Change</button>");
    expect(occurrences(html, 'aria-label="Remove the picture on')).toBe(1);
    // ...and rule 14's ragged message reaches the section the pictures are in.
    const ragged = validateFlow(pictured).failures.find((f) => f.code === "option_images_ragged");
    expect(html).toContain(esc(ragged!.message));
  });

  // CUT 4 AT THE LAST SURFACE THAT COULD BREAK IT. A picture is PICKED from the
  // manifest; there is no box to type a reference into, so no URL can reach the
  // jsonb behind a public page.
  it("never lets a picture reference be typed", () => {
    const code = codeOnly(inspectorSource);
    expect(code).toContain("assessImagesForSlot");
    expect(code).toContain("image.key");
    // The one place a reference is written is a click on a manifest entry.
    expect(code).not.toMatch(/kind: "block-image", index, image: [a-z]*\.target/);
    expect(code).not.toMatch(/kind: "option-image", value: [^}]*target\.value/);
    for (const block of ["block-image", "option-image"]) {
      expect(code, `${block} is emitted from a text box`).not.toMatch(
        new RegExp(`onBlur[^)]*${block}`),
      );
    }
  });
});

describe("the rail still decides nothing about a block", () => {
  const code = codeOnly(inspectorSource);

  // MUTATION: call addBlock/setBlockText/setOptionImage from a handler here and
  // the rules they carry - which kinds may be added, what a blank line does, which
  // slot a key must fit - move into a file vitest collects nothing from.
  it("imports no block WRITE op, only the readers", () => {
    for (const op of [
      "addBlock(",
      "removeBlock(",
      "moveBlock(",
      "setBlockText",
      "setBlockImage",
      "addBlockChip",
      "addBlockFaqItem",
      "removeBlockItem",
      "setOptionImage",
      "removeOptionImage",
    ]) {
      expect(code, `the rail calls ${op}`).not.toContain(op);
    }
    for (const reader of [
      "addableBlockKinds",
      // WHY the picker is empty is a rule too, and one that stopped being a
      // single sentence when a result screen gained a fifth legal kind.
      "noAddableBlockReason",
      "optionImageRows",
      "questionSwapWarning",
      "blockIssues",
    ]) {
      expect(code, `${reader} is not read from the pure layer`).toContain(reader);
    }
    // Which screens take blocks is blocksOf/addableBlockKinds' answer, never a
    // second list of node kinds written here.
    expect(code).not.toContain("FLOW_BLOCK_KINDS");
    expect(code).not.toContain("acceptsBlocks");
  });

  // MUTATION: drop the warning and swapping a question silently deletes the
  // pictures the owner assigned. There is no confirm dialog in this rail - the
  // pattern is words - so the words have to be there before the swap.
  it("says what changing a question would cost, before it is changed", () => {
    const g = invisalign();
    const pictured = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === "q-smile_concern"
          ? { ...n, optionImages: [{ value: "crowded", image: "conditions/crowded" }] }
          : n,
      ),
    } as FlowGraph;
    const warning = questionSwapWarning(pictured, "q-smile_concern");
    expect(warning).toBeTruthy();
    expect(rail(pictured, { kind: "node", id: "q-smile_concern" })).toContain(esc(warning!));
    // ...and nothing is said on a step with no pictures to lose.
    expect(rail(g, { kind: "node", id: "q-smile_concern" })).not.toContain("Changing the question removes");
  });
});

/* ---------------------------------------------------------------------------
 * 9. THE LIVE MINIS. A block edited in the rail is drawn on the phone beside it.
 *
 * The builder holds ONE graph and derives everything from it, so this is a
 * question about the derivation rather than about React: the edit goes through
 * applyInspectorEdit onto the draft graph, screenFor projects that graph, and the
 * mini draws the projection. Each link is checked, plus the memo that makes the
 * builder recompute the middle one.
 * ------------------------------------------------------------------------- */

describe("an edited block reaches the phone beside the rail", () => {
  it("travels intent -> draft graph -> screen -> mini", () => {
    const before = invisalign();
    const beforeScreen = screenFor(nodeOf(before, "welcome"), before, {}, 1);
    expect(beforeScreen.kind === "welcome-question" ? beforeScreen.blocks : ["x"]).toEqual([]);

    const edited = applyInspectorEdit(before, { kind: "node", id: "welcome" }, {
      kind: "add-block",
      blockKind: "trust-strip",
      practiceName: "Vitality Dental",
    });
    expect(edited.ok, edited.ok ? "" : edited.reason).toBe(true);
    if (!edited.ok) return;

    // The projection the builder feeds the strip, off the DRAFT graph.
    const screen = screenFor(nodeOf(edited.graph, "welcome"), edited.graph, {}, 1);
    expect(screen.kind).toBe("welcome-question");
    const blocks = screen.kind === "welcome-question" ? screen.blocks : [];
    expect(blocks).toEqual([
      { kind: "trust-strip", practiceName: "Vitality Dental", chips: ["Takes about 30 seconds"] },
    ]);

    // ...and the mini draws it.
    const html = strip(edited.graph, { selectedId: "welcome" });
    expect(html).toContain(esc("Takes about 30 seconds"));
    expect(strip(before)).not.toContain(esc("Takes about 30 seconds"));
  });

  it("redraws an answer picture the moment it is picked", () => {
    const picked = applyInspectorEdit(invisalign(), { kind: "node", id: "q-smile_concern" }, {
      kind: "option-image",
      value: "crowded",
      image: "conditions/crowded",
    });
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(strip(picked.graph)).toContain(`src="${assessImage("conditions/crowded")!.path}"`);
    expect(strip(invisalign())).not.toContain(`src="${assessImage("conditions/crowded")!.path}"`);
  });

  // MUTATION: memoise the screens on anything but the graph - the node list, the
  // campaign copy - and every edit in the rail leaves the phones showing the
  // funnel as it was, which reads as the edit not having happened.
  it("recomputes the strip's screens from the draft graph on every edit", () => {
    const code = codeOnly(builderSource);
    const at = code.indexOf("const screens = useMemo");
    expect(at, "the builder no longer memoises the screens").toBeGreaterThan(-1);
    const memo = code.slice(at, code.indexOf("}, [", at) + 40);
    expect(memo).toContain("screenFor(");
    expect(memo).toMatch(/\}, \[[^\]]*\bgraph\b/);
  });
});

/* ---------------------------------------------------------------------------
 * 8. "WRITE THIS FOR ME": the rail ASKS, the builder fetches, the answer lands
 *    through the ordinary edit intents.
 *
 * The seam this suite exists for, one lane further on. Three things can only be
 * held here: that the rail emits without fetching, that the two boxes nothing
 * writes for you have no button, and that the builder hands the answer back to
 * `onEdit` rather than to the graph.
 * ------------------------------------------------------------------------- */

describe("write this for me", () => {
  const withBlocks = (blocks: FlowBlock[]): FlowGraph => {
    const graph = invisalign();
    return {
      ...graph,
      nodes: graph.nodes.map((n) => (n.kind === "welcome" ? { ...n, blocks } : n)),
    };
  };

  const TRUST: FlowBlock = {
    kind: "trust-strip",
    practiceName: "Vitality Dental",
    chips: ["Open Saturdays", "Takes about 30 seconds"],
  };
  const FAQ: FlowBlock = {
    kind: "faq",
    items: [
      { q: "How soon could I be seen?", a: "Usually within a week or so." },
      { q: "What happens next?", a: "The team will call you back." },
    ],
  };
  const TESTIMONIAL: FlowBlock = {
    kind: "testimonial",
    quote: "The team looked after me from start to finish.",
    attribution: "Sam, Wood Green",
  };

  function railAsking(
    graph: FlowGraph,
    selection: FlowSelection | null,
    assisting: string | null = null,
  ): { html: string; asked: AssistTarget[] } {
    const asked: AssistTarget[] = [];
    const html = renderToStaticMarkup(
      createElement(FlowInspector, {
        graph,
        selection,
        failures: validateFlow(graph).failures,
        onEdit: () => {},
        onSelect: () => {},
        onAssist: (t: AssistTarget) => asked.push(t),
        assisting,
      }),
    );
    return { html, asked };
  }

  const buttons = (html: string) => occurrences(html, "Write this for me");

  // MUTATION: drop the prop and the buttons are drawn anyway. The rail would then
  // need somewhere to send the request, which is the whole of the builder.
  it("draws no button at all when nothing is listening", () => {
    expect(buttons(rail(invisalign(), { kind: "node", id: "welcome" }))).toBe(0);
    expect(buttons(railAsking(invisalign(), { kind: "node", id: "welcome" }).html)).toBeGreaterThan(0);
  });

  // MUTATION: hand the button a target it built itself ("the selected node") and a
  // block line would be written onto whichever block happens to be first.
  it("puts one on every copy box the pure layer says may be written", () => {
    const graph = withBlocks([TRUST, FAQ, TESTIMONIAL]);
    const fromTheRules =
      2 + // the opening headline and the opening line
      [TRUST, FAQ, TESTIMONIAL].reduce(
        (sum, b) =>
          sum + blockCopyFields(b).filter((f) => isAssistableBlockField(b.kind, f.field)).length,
        0,
      );
    expect(buttons(railAsking(graph, { kind: "node", id: "welcome" }).html)).toBe(fromTheRules);
  });

  // MUTATION: the charter one. A quote is the practice's own words and nothing
  // here writes one - and the same goes for the name on a trust strip, which is a
  // fact rather than a line of copy.
  it("has no button on a testimonial, or on the practice's own name", () => {
    const { html } = railAsking(withBlocks([TESTIMONIAL, TRUST]), { kind: "node", id: "welcome" });
    // The boxes are all there to type in...
    expect(html).toContain(esc("The quote, in their words"));
    expect(html).toContain(esc("Who gave it"));
    expect(html).toContain(esc("Practice name"));
    // ...and the aria-labels prove which of them offered to write themselves.
    expect(html).not.toContain("Write the quote, in their words for me");
    expect(html).not.toContain("Write who gave it for me");
    expect(html).not.toContain("Write practice name for me");
    expect(html).toContain("Write chip 1 for me");
  });

  it("offers one on a question's lead-in, a result headline and a connection", () => {
    const graph = invisalign();
    expect(buttons(railAsking(graph, { kind: "node", id: "q-treatment_interest" }).html)).toBe(1);
    expect(buttons(railAsking(graph, { kind: "node", id: "result-high" }).html)).toBe(1);
    expect(buttons(railAsking(graph, { kind: "edge", index: 0 }).html)).toBe(1);
    // The contact screen has no copy of its own, so it has nothing to write.
    expect(buttons(railAsking(graph, { kind: "node", id: "contact" }).html)).toBe(0);
  });

  // MUTATION: a boolean instead of the key. Every button would then say "Writing",
  // and the owner could not tell which line was on its way.
  it("flattens every button while one line is being written, and only that one says so", () => {
    const graph = withBlocks([FAQ]);
    const key = assistTargetKey({ nodeId: "welcome", field: "headline" });
    const { html } = railAsking(graph, { kind: "node", id: "welcome" }, key);
    expect(occurrences(html, "Writing<")).toBe(1);
    expect(occurrences(html, "disabled=")).toBeGreaterThanOrEqual(buttons(html) + 1);
  });

  // MUTATION: fetch from the rail. Every rule about what may be written, what the
  // budget is and where the line lands would move into a file vitest collects
  // nothing from - the exact failure this whole layer exists to stop.
  it("emits the target and nothing else: the rail still cannot reach a server", () => {
    const code = codeOnly(inspectorSource);
    expect(code).toContain("onAssist(target)");
    expect(code).not.toContain("fetch(");
    expect(code).not.toContain("assistCopy");
    expect(code).not.toContain("flow-copy-assist");
    // The one rule it reads rather than restates: which block lines may be asked
    // for. Every place the handler is passed on is either passed WHOLE or passed
    // through that helper - a `blockField === "quote"` test written here instead
    // is the version of this rule that comes back the next time a block kind is
    // added and nobody remembers the charter clause.
    const passes = code.match(/onAssist=\{[^}]*\}/g) ?? [];
    expect(passes.length).toBeGreaterThan(0);
    for (const pass of passes) {
      expect(
        pass === "onAssist={onAssist}" ||
          pass === "onAssist={isAssistableBlockField(block.kind, field.field) ? onAssist : undefined}",
        `the rail decides for itself who may be written: ${pass}`,
      ).toBe(true);
    }
  });

  // MUTATION: land it with setGraph. It would bypass applyInspectorEdit, and with
  // it every trim, every "that screen has no such box" and every refusal.
  it("lands the written line through the same edit intents a typed line takes", () => {
    const code = codeOnly(builderSource);
    expect(code).toContain("const edit = assistEditFor(target, text);");
    expect(code).toContain("live.current.onEdit(edit)");
    const at = code.indexOf("const onAssist = useCallback");
    expect(at).toBeGreaterThan(-1);
    const handler = code.slice(at, code.indexOf("[assisting, clientSlug, practiceName]", at));
    expect(handler).not.toContain("setGraph");
    expect(handler).not.toContain("applyInspectorEdit");
    // ...and it refuses to land at all once the ground has moved.
    expect(handler).toContain("canLandAssist(live.current.graph, live.current.selected, target)");
    expect(handler).toContain("setRefusal(ASSIST_TARGET_MOVED)");

    // THE STAMP, AND WHY IT IS PINNED HERE. canLandAssist only checks identity when
    // the target carries a fingerprint (`at`), so the check is exactly as good as
    // the promise that the one caller in this codebase always stamps one. The rail
    // emits a bare target - it is dumb by design - so the stamping happens here, at
    // press time, off the SAME live graph the landing is checked against.
    //
    // MUTATION: send `raw` instead of the stamped target, or stamp from the render
    // closure's `graph` instead of `live.current.graph`, and a block reordered
    // during the round trip takes the line silently.
    expect(handler).toContain("assistFingerprint(live.current.graph, raw)");
    expect(handler).toContain("{ ...raw, at }");
    // A box that has already gone has no fingerprint, and that is a refusal rather
    // than a reason to skip the check.
    expect(handler).toContain("if (at === null)");
    expect(handler).not.toContain("canLandAssist(live.current.graph, live.current.selected, raw)");
  });

  // MUTATION: a second raw fetch. The `await fetch(` count is the file's promise
  // that the draft graph leaves by exactly one road; routing every call through
  // one helper is what keeps that promise honest rather than merely worded.
  //
  // THE HELPER COUNT IS THREE, AND IT IS MEANT TO MOVE. It is a census of the
  // requests this builder makes, not a ceiling on them: one PUT that saves, one
  // POST that writes a single line, one POST that rewrites the whole funnel's
  // words. Raising it is a decision - a fourth call means a fourth thing the
  // builder can do to an owner's funnel, and it should be read as such rather
  // than absorbed. The `await fetch(` count is the one that must NEVER move.
  it("asks through the one request helper, and still saves through the one PUT", () => {
    const code = codeOnly(builderSource);
    expect(occurrences(code, "await fetch(")).toBe(1);
    expect(occurrences(code, "await callFlowApi(")).toBe(3);
    expect(occurrences(code, 'method: "PUT"')).toBe(1);
    expect(code).toContain("/api/smile-assessment/flow-copy-assist?client=");
    expect(code).toContain("/api/smile-assessment/flow-generate");
    // The rail is handed both halves, or the buttons spin for ever.
    expect(code).toContain("onAssist={onAssist}");
    expect(code).toContain("assisting={assisting}");
  });

  // -------------------------------------------------------------------------
  // "REWRITE THE WORDS": the same idea at funnel scale, and the one control in
  // this builder that replaces the whole graph. Everything below is about the
  // three things that make that defensible.
  // -------------------------------------------------------------------------

  // MUTATION: send `mode: "draft"`, or leave the mode off. The route would then
  // WRITE A NEW FUNNEL - different questions, different routing - and drop it on
  // top of one the owner built, from a button that says it rewrites the words.
  it("asks the funnel route to rewrite, carrying the funnel that is on the canvas", () => {
    const code = codeOnly(builderSource);
    expect(code).toContain("/api/smile-assessment/flow-generate");
    expect(code).toContain('mode: "rewrite"');
    expect(code).toContain("flow: sent");
    expect(code).toContain("const sent = graph;");
  });

  // MUTATION: setGraph(data.flow). An unvalidated funnel from a reply would land
  // on the canvas and be drawn - the exact thing the gallery re-validates against
  // for a fresh draft, on a path that overwrites work rather than starting it.
  it("re-validates the rewritten funnel with the runtime's own gate before it lands", () => {
    const code = codeOnly(builderSource);
    const at = code.indexOf("const rewrite = useCallback");
    expect(at).toBeGreaterThan(-1);
    const handler = code.slice(at, code.indexOf("}, [clientSlug, goal, graph", at));

    expect(handler).toContain("const { graph: next } = normaliseAndValidateFlow(data.flow);");
    // The order matters: validate, then check the ground has not moved, and only
    // then set. A setGraph before either is a setGraph that cannot be taken back.
    expect(handler.indexOf("normaliseAndValidateFlow")).toBeLessThan(handler.indexOf("setGraph(next)"));
    expect(handler.indexOf("JSON.stringify(live.current.graph)")).toBeLessThan(
      handler.indexOf("setGraph(next)"),
    );
    expect(occurrences(handler, "setGraph(")).toBe(1);
  });

  // MUTATION: drop the moved-graph check. The owner types a headline while the
  // rewrite is in flight, the reply lands, and their typing is gone - silently,
  // from a control that never said it would touch anything they were working on.
  it("refuses to land a rewrite on a funnel that changed while it was being written", () => {
    const code = codeOnly(builderSource);
    expect(code).toContain(
      "if (JSON.stringify(live.current.graph) !== JSON.stringify(sent)) {",
    );
    expect(code).toContain("You changed the funnel while the words were being written");
  });

  // MUTATION: treat `unchanged` as success. The owner is shown "the words were
  // rewritten" over a funnel nothing happened to, and goes looking for what moved.
  it("says so, in words, when the server could not improve on what is there", () => {
    const code = codeOnly(builderSource);
    expect(code).toContain('if (data.source === "unchanged")');
    expect(code).toContain("could not improve on what is there");
    // Every other road out of the handler speaks too: a spinner that stops with
    // nothing said is the version of this an owner stops trusting.
    for (const said of [
      "The words could not be rewritten just now",
      "did not pass its checks",
      "The writer could not be reached",
      "The words were rewritten",
    ]) {
      expect(code, `a silent exit: ${said}`).toContain(said);
    }
  });

  // MUTATION: render it unconditionally. With no goal the writer has nothing to
  // brief it on but the questions, and a rewrite briefed on nothing is a rewrite
  // that reads like a different practice.
  it("offers the control only when the campaign's goal is known, and hands it down", () => {
    const code = codeOnly(builderSource);
    expect(code).toContain("{goal ? (");
    expect(code).toContain("Rewrite the words");
    expect(code).toContain("if (!goal || rewriting || saving) return;");
    // ...and the panel supplies it off the campaign, never off the funnel.
    expect(codeOnly(panelSource)).toContain("goal={campaign.goal}");
  });

  // MUTATION: leave the box uncontrolled AND keyed by the step alone. The line
  // would be on the graph and the old words still in the box, which reads exactly
  // like the button having done nothing.
  it("re-mounts a copy box when the line under it changes", () => {
    const code = codeOnly(inspectorSource);
    for (const key of [
      "key={`wh-${node.id}-${node.headline ?? \"\"}`}",
      "key={`wi-${node.id}-${node.intro ?? \"\"}`}",
      "key={`tr-${node.id}-${node.transition ?? \"\"}`}",
      "key={`hl-${node.id}-${node.headline ?? \"\"}`}",
    ]) {
      expect(code, `a box is keyed without its own line: ${key}`).toContain(key);
    }
    // ...and it really does redraw: the same rail, one written line apart.
    const before = invisalign();
    const after = applyInspectorEdit(before, { kind: "node", id: "welcome" }, {
      kind: "headline",
      text: "Tell us what you would change.",
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(railAsking(after.graph, { kind: "node", id: "welcome" }).html).toContain(
      esc("Tell us what you would change."),
    );
  });
});
